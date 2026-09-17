// Dry run by default. --apply changes only branding images and public derivatives.
// Original private media, orders, entitlements and video teasers are untouched.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { getDb, transaction, closeDb } = require('../db/database');
const root = path.resolve(__dirname, '../..');
const job = path.resolve(__dirname, '../.test-runs/image-opt-' + crypto.randomUUID());
const apply = process.argv.includes('--apply');
const python = String.raw`
import sys,json
from pathlib import Path
from PIL import Image,ImageOps,ImageFilter
job=Path(sys.argv[1]); manifest=json.loads((job/'input.json').read_text(encoding='utf-8'))
report=[]
for item in manifest:
 source=job/item['input']; target=job/item['output']; img=ImageOps.exif_transpose(Image.open(source));before=img.size
 if item['kind']=='preview':
  img=ImageOps.fit(img.convert('RGB'),(40,50),method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(2.2))
  img.save(target,'JPEG',quality=82,optimize=True)
 elif item['kind']=='badge':
  img=img.convert('RGBA').resize((48,48),Image.Resampling.LANCZOS).quantize(colors=64,method=Image.Quantize.FASTOCTREE)
  img.save(target,'PNG',optimize=True)
 else:
  if img.mode not in ['RGB','RGBA']: img=img.convert('RGB')
  role=item['kind']; scale=min(1,320/max(img.size) if role=='avatar' else 1280/img.width)
  img=img.resize((max(1,round(img.width*scale)),max(1,round(img.height*scale))),Image.Resampling.LANCZOS)
  budget=25*1024 if role=='avatar' else 150*1024
  for quality in [80 if role=='avatar' else 78,70,60,50]:
   img.save(target,'WEBP',quality=quality,method=6)
   if target.stat().st_size<=budget: break
  if target.stat().st_size>budget: raise Exception('Image exceeds budget')
 report.append(dict(kind=item['kind'],beforeBytes=source.stat().st_size,afterBytes=target.stat().st_size,beforeSize=before,afterSize=img.size))
(job/'report.json').write_text(json.dumps(report,indent=2))
`;
async function main() {
  fs.mkdirSync(job, { recursive: true });
  const db = await getDb();
  const profile = await db.get("SELECT * FROM creator_profiles WHERE id='ayla'");
  if (!profile?.avatar_path || !profile?.cover_path) throw new Error('Configured profile required');
  const entries = [];
  for (const role of ['avatar','cover']) {
    const data = await require('../services/profile-media').bytes(profile[role + '_path']);
    fs.writeFileSync(path.join(job, role + '.original'), data.body);
    entries.push({ kind: role, input: role + '.original', output: role + '.webp' });
  }
  const tables = {};
  for (const table of ['vip_posts','vip_post_media']) {
    tables[table] = await db.all(`SELECT id,preview_image FROM ${table} WHERE preview_image IS NOT NULL AND preview_image<>''`);
    for (const [index, row] of tables[table].entries()) {
      const file = `${table}-${index}`; row.file = file;
      fs.writeFileSync(path.join(job,file+'.original'), Buffer.from(row.preview_image.replace(/^data:image\/jpeg;base64,/,''),'base64'));
      entries.push({ kind:'preview', input:file+'.original', output:file+'.jpg' });
    }
  }
  for (const name of fs.readdirSync(path.join(root,'previews')).filter(n=>/^post-\d\d\.jpg$/.test(n))) {
    fs.copyFileSync(path.join(root,'previews',name), path.join(job,name+'.original'));
    entries.push({kind:'preview',input:name+'.original',output:name,staticPath:'previews/'+name});
  }
  fs.copyFileSync(path.join(root,'verified-ayla.png'),path.join(job,'badge.original'));
  entries.push({kind:'badge',input:'badge.original',output:'badge.png',staticPath:'verified-ayla.png'});
  fs.writeFileSync(path.join(job,'backup.json'),JSON.stringify({profile,tables}));
  fs.writeFileSync(path.join(job,'input.json'),JSON.stringify(entries));
  execFileSync('python',['-c',python,job],{stdio:'pipe'});
  const report=JSON.parse(fs.readFileSync(path.join(job,'report.json'),'utf8'));
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',images:report.slice(0,2),previews:report.filter(r=>r.kind==='preview').length,previewMaxBytes:Math.max(...report.filter(r=>r.kind==='preview').map(r=>r.afterBytes)),badge:report.at(-1)}));
  if (!apply) { console.log('Prepared privately:',job); return; }
  const prefix='ayla/profile/optimized-'+crypto.randomUUID();
  const paths={};
  for (const role of ['avatar','cover']) {
    paths[role]=prefix+'-'+role+'.webp';
    const encoded=paths[role].split('/').map(encodeURIComponent).join('/');
    const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const response=await fetch(process.env.SUPABASE_URL.replace(/\/+$/,'')+'/storage/v1/object/'+encodeURIComponent(process.env.VIP_MEDIA_BUCKET)+'/'+encoded,{
      method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'image/webp','Cache-Control':'31536000','x-upsert':'false'},body:fs.readFileSync(path.join(job,role+'.webp'))
    });
    if(!response.ok)throw new Error('Optimized image upload failed: '+response.status);
  }
  await transaction(async tx=>{
    const result=await tx.run("UPDATE creator_profiles SET avatar_path=?,cover_path=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id='ayla' AND version=?",paths.avatar,paths.cover,profile.version);
    if(!result.changes)throw new Error('Profile changed during optimization; no database changes applied');
    for(const [table,rows] of Object.entries(tables))for(const row of rows){
      const base64=fs.readFileSync(path.join(job,row.file+'.jpg')).toString('base64');
      const changed=await tx.run(`UPDATE ${table} SET preview_image=? WHERE id=? AND preview_image=?`,base64,row.id,row.preview_image);
      if(!changed.changes)throw new Error('Preview changed during optimization; no database changes applied');
    }
  });
  for(const entry of entries.filter(e=>e.staticPath))fs.copyFileSync(path.join(job,entry.output),path.join(root,entry.staticPath));
  console.log('Applied; original files and rollback data retained privately:',job);
}
main().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;}).finally(closeDb);
