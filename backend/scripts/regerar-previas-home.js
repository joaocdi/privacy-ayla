// Regenera as prévias públicas da HOME (a "derivada" borrada de cada post)
// a partir das mídias originais, em 160x200 com desfoque leve.
//
// Dry run por padrão: baixa as mídias, gera as prévias e mostra o relatório,
// sem mexer no banco. Com --apply grava as novas prévias.
//
//   node backend/scripts/regerar-previas-home.js
//   node backend/scripts/regerar-previas-home.js --apply
//
// O original continua privado e não é alterado. As prévias antigas ficam
// guardadas em backend/.test-runs/preview-regen-<id>/backup.json.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { getDb, transaction, closeDb } = require('../db/database');
const media = require('../services/vip-media');
const previewImage = require('../services/preview-image');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;

const apply = process.argv.includes('--apply');
const job = path.resolve(__dirname, '../.test-runs/preview-regen-' + crypto.randomUUID());
const W = 160, H = 200, BLUR = 2.0, QUALITY = 72;
const MAX_SOURCE = 400 * 1024 * 1024;

const python = String.raw`
import sys,json
from pathlib import Path
from PIL import Image,ImageOps,ImageFilter
job=Path(sys.argv[1]); W,H,BLUR,Q=int(sys.argv[2]),int(sys.argv[3]),float(sys.argv[4]),int(sys.argv[5])
report=[]
for item in json.loads((job/'input.json').read_text(encoding='utf-8')):
  img=ImageOps.exif_transpose(Image.open(job/item['frame'])).convert('RGB')
  big=ImageOps.fit(img,(round(W*1.2),round(H*1.2)),method=Image.Resampling.LANCZOS)
  left=(big.width-W)//2; top=(big.height-H)//2
  small=big.crop((left,top,left+W,top+H)).filter(ImageFilter.GaussianBlur(BLUR))
  small.save(job/item['output'],'JPEG',quality=Q,optimize=True)
  report.append(dict(output=item['output'],bytes=(job/item['output']).stat().st_size))
(job/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
`;

async function originalBytes(row) {
  const source = media.safeObjectPath(row.media_path);
  if (!source) throw new Error('caminho de mídia inválido');
  const driver = String(row.media_driver || media.driverName()).toLowerCase();
  if (driver === 'supabase') {
    const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const bucket = (process.env.VIP_MEDIA_BUCKET || '').trim();
    if (!url || !key || !bucket) throw new Error('Supabase não configurado em backend/.env');
    const encoded = source.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encoded}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(180000)
    });
    if (!response.ok) throw new Error('mídia indisponível (' + response.status + ')');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_SOURCE) throw new Error('mídia grande demais');
    return body;
  }
  const file = media.resolveSource(source);
  if (!file) throw new Error('arquivo local não encontrado');
  return fs.readFileSync(file);
}

// Extrai um quadro (vídeo) ou usa a própria imagem como base da prévia.
async function frameFor(row, cache) {
  if (cache.has(row.media_path)) return cache.get(row.media_path);
  const name = 'src-' + cache.size;
  const input = path.join(job, name + '.bin');
  fs.writeFileSync(input, await originalBytes(row));
  let frame = input;
  if (row.type === 'video') {
    frame = path.join(job, name + '.jpg');
    for (const seek of ['1', '0']) {
      try {
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seek, '-i', input,
          '-frames:v', '1', '-an', '-map_metadata', '-1', '-q:v', '2', frame], { stdio: 'pipe' });
        if (fs.existsSync(frame) && fs.statSync(frame).size > 0) break;
      } catch (error) { if (seek === '0') throw new Error('não foi possível extrair quadro do vídeo'); }
    }
  }
  if (input !== frame) fs.rmSync(input, { force: true });
  const relative = path.basename(frame);
  cache.set(row.media_path, relative);
  return relative;
}

async function main() {
  fs.mkdirSync(job, { recursive: true });
  const db = await getDb();
  const mediaRows = await db.all(`SELECT id,post_id,type,media_path,media_driver,sort_order,preview_image FROM vip_post_media
    WHERE preview_image IS NOT NULL AND preview_image<>'' ORDER BY post_id,sort_order`);
  const postRows = await db.all(`SELECT id,type,media_path,media_driver,preview_image FROM vip_posts
    WHERE creator_id='ayla' AND preview_image IS NOT NULL AND preview_image<>''`);
  const firstMedia = new Map();
  for (const row of mediaRows) if (!firstMedia.has(row.post_id)) firstMedia.set(row.post_id, row);

  const targets = [];
  for (const row of mediaRows) targets.push({ table: 'vip_post_media', row, from: row });
  for (const row of postRows) {
    const from = row.media_path ? row : firstMedia.get(row.id);
    if (!from) { console.log('Pulando post sem mídia original:', row.id); continue; }
    targets.push({ table: 'vip_posts', row, from });
  }

  const cache = new Map(), entries = [], failures = [];
  for (const [index, target] of targets.entries()) {
    try {
      const frame = await frameFor(target.from, cache);
      target.output = `${target.table}-${index}.jpg`;
      entries.push({ frame, output: target.output });
    } catch (error) {
      failures.push({ table: target.table, id: target.row.id, error: error.message });
    }
  }
  fs.writeFileSync(path.join(job, 'backup.json'), JSON.stringify(targets.map(t => ({ table: t.table, id: t.row.id, preview_image: t.row.preview_image }))));
  fs.writeFileSync(path.join(job, 'input.json'), JSON.stringify(entries));
  execFileSync('python', ['-c', python, job, String(W), String(H), String(BLUR), String(QUALITY)], { stdio: 'pipe' });
  // As cópias das mídias originais não ficam guardadas: só as prévias e o backup.
  for (const file of fs.readdirSync(job)) if (file.startsWith('src-')) fs.rmSync(path.join(job, file), { force: true });

  const ready = targets.filter(t => t.output && fs.existsSync(path.join(job, t.output)));
  for (const t of ready) {
    t.base64 = previewImage.normalize(fs.readFileSync(path.join(job, t.output)).toString('base64'));
    if (!t.base64) throw new Error('Prévia gerada fora do limite aceito pelo servidor: ' + t.output);
  }
  const sizes = ready.map(t => Buffer.from(t.base64, 'base64').length);
  console.log(JSON.stringify({
    modo: apply ? 'apply' : 'dry-run', previas: ready.length, falhas: failures,
    tamanho: `${W}x${H}`, maiorKB: sizes.length ? +(Math.max(...sizes) / 1024).toFixed(1) : 0
  }, null, 2));
  if (!apply) { console.log('Prévias geradas para conferir em:', job); return; }
  if (failures.length) throw new Error('Há falhas; nada foi gravado. Corrija e rode de novo.');

  await transaction(async tx => {
    for (const t of ready) {
      const changed = await tx.run(`UPDATE ${t.table} SET preview_image=? WHERE id=? AND preview_image=?`, t.base64, t.row.id, t.row.preview_image);
      if (!changed.changes) throw new Error('Uma prévia mudou durante o processo; nada foi gravado.');
    }
  });
  console.log('Aplicado. Prévias antigas guardadas em:', path.join(job, 'backup.json'));
}

main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; }).finally(closeDb);
