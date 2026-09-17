const crypto = require('crypto');
const { getDb, transaction } = require('../db/database');
const { fail } = require('./vip-posts');
const { driverName } = require('./vip-media');
const previewVideo = require('./preview-video');
const CHUNK = 3 * 1024 * 1024;
const FORMATS = { 'image/jpeg': ['jpg','image'], 'image/png': ['png','image'], 'image/webp': ['webp','image'], 'video/mp4': ['mp4','video'], 'video/webm': ['webm','video'] };
function config() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.VIP_MEDIA_BUCKET;
  if (driverName() !== 'supabase' || !/^https:\/\//.test(url) || !key || !bucket) throw fail('Configure o Storage privado Supabase para enviar mídias.', 503);
  return { url, key, bucket };
}
function maxSize() {
  const requested = Number(process.env.ADMIN_UPLOAD_MAX_MB || 250);
  return Math.min(500, Math.max(1, Number.isFinite(requested) ? requested : 250)) * 1024 * 1024;
}
async function request(url, options = {}) {
  const { key } = config();
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(options.method === 'HEAD' ? 5000 : 18000),
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Tus-Resumable': '1.0.0', ...options.headers } });
  if (!response.ok) throw fail('Storage indisponível ou upload recusado. Tente novamente.', 502);
  return response;
}
async function start(input, sessionId) {
  const { url, bucket } = config();
  const format = FORMATS[input.mime];
  // O teaser da HOME vai para uma pasta própria e com limite próprio: ele é
  // uma derivada de poucos segundos, não pode ocupar o lugar de um original.
  const preview = input.purpose === 'preview';
  if (preview && format?.[1] !== 'video') throw fail('O teaser da HOME precisa ser um vídeo MP4 ou WebM.');
  const ceiling = preview ? previewVideo.MAX_BYTES : maxSize();
  if (!format || !Number.isInteger(input.size) || input.size < 12 || input.size > ceiling) {
    throw fail(preview ? 'Teaser grande demais. Ele deve ter poucos segundos em baixa resolução.'
      : 'Formato ou tamanho não permitido. Use JPG, PNG, WebP, MP4 ou WebM.');
  }
  const bucketResponse = await request(`${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`);
  const bucketData = await bucketResponse.json();
  if (bucketData.public !== false) throw fail('O bucket precisa ser privado. Upload bloqueado.', 409);
  if (bucketData.file_size_limit && input.size > Number(bucketData.file_size_limit)) throw fail('Arquivo excede o limite do bucket.');
  const id = crypto.randomUUID();
  const object = preview ? `${previewVideo.PREFIX}${id}.${format[0]}` : `ayla/posts/${id}.${format[0]}`;
  const metadata = Object.entries({ bucketName: bucket, objectName: object, contentType: input.mime, cacheControl: '60' })
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',');
  await (await getDb()).run("UPDATE vip_uploads SET pending_chunk='',remote_url=NULL WHERE expires_at<? AND complete=0", Date.now());
  const response = await request(`${url}/storage/v1/upload/resumable`, { method: 'POST', headers: { 'Upload-Length': String(input.size), 'Upload-Metadata': metadata, 'x-upsert': 'false' } });
  const location = response.headers.get('location');
  const remote = location && new URL(location, url);
  const allowedOrigins = new Set([new URL(url).origin]);
  const direct = new URL(url);
  if (direct.hostname.endsWith('.supabase.co') && !direct.hostname.endsWith('.storage.supabase.co')) {
    direct.hostname = direct.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co');
    allowedOrigins.add(direct.origin);
  }
  if (!remote || !allowedOrigins.has(remote.origin) || !remote.pathname.startsWith('/storage/v1/upload/resumable/')) throw fail('Storage retornou destino inválido.', 502);
  await (await getDb()).run(`INSERT INTO vip_uploads(id,session_id,media_path,mime_type,type,size_bytes,remote_url,expires_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, sessionId, object, input.mime, format[1], input.size, remote.href, Date.now() + 23 * 60 * 60 * 1000);
  return { id, offset: 0, complete: false, chunkSize: CHUNK };
}
function sniff(bytes, mime) {
  if (mime === 'image/jpeg') return bytes.subarray(0,3).equals(Buffer.from([255,216,255]));
  if (mime === 'image/png') return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (mime === 'video/mp4') return bytes.toString('ascii',4,8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  return false;
}
async function status(id, sessionId) {
  const row = await (await getDb()).get('SELECT id,received_bytes,complete FROM vip_uploads WHERE id=? AND session_id=? AND expires_at>?', id, sessionId, Date.now());
  if (!row) throw fail('Upload expirado ou não encontrado.', 404);
  return { id: row.id, offset: Number(row.received_bytes), complete: Boolean(row.complete), chunkSize: CHUNK };
}
async function chunk(id, sessionId, offset, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > CHUNK || !Number.isSafeInteger(offset) || offset < 0) throw fail('Bloco de upload inválido.');
  return transaction(async db => {
    // Lock persists across instances and also serializes concurrent retries.
    await db.run('UPDATE vip_uploads SET updated_at=CURRENT_TIMESTAMP WHERE id=? AND session_id=?', id, sessionId);
    const row = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND expires_at>?', id, sessionId, Date.now());
    if (!row || !row.remote_url) throw fail('Upload expirado ou não encontrado.', 404);
    if (offset < row.received_bytes) return { id, offset: Number(row.received_bytes), complete: Boolean(row.complete) };
    if (row.complete || offset !== row.received_bytes || bytes.length !== Math.min(CHUNK, row.size_bytes - offset)) throw fail('Posição de upload inválida.', 409);
    if (offset === 0 && !sniff(bytes, row.mime_type)) throw fail('O conteúdo não corresponde ao formato selecionado.');
    const pending = Buffer.concat([Buffer.from(row.pending_chunk, 'base64'), bytes]);
    const next = offset + bytes.length;
    let remoteBytes = Number(row.remote_bytes);
    let pendingText = pending.toString('base64');
    if (pending.length === CHUNK * 2 || next === row.size_bytes) {
      const head = await request(row.remote_url, { method: 'HEAD' });
      const remoteOffset = Number(head.headers.get('upload-offset'));
      if (remoteOffset === remoteBytes) {
        const result = await request(row.remote_url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(remoteBytes) }, body: pending });
        if (Number(result.headers.get('upload-offset')) !== next) throw fail('Storage não confirmou o bloco.', 502);
      } else if (remoteOffset !== next) {
        throw fail('Upload remoto inconsistente. Inicie outro envio.', 409);
      }
      // If the previous PATCH succeeded but its response was lost, HEAD confirms it.
      remoteBytes = next;
      pendingText = '';
    }
    const complete = next === row.size_bytes && remoteBytes === next;
    await db.run('UPDATE vip_uploads SET received_bytes=?,remote_bytes=?,pending_chunk=?,complete=? WHERE id=?', next, remoteBytes, pendingText, Number(complete), id);
    return { id, offset: next, complete };
  });
}
module.exports = { start, chunk, status, maxSize, CHUNK };
