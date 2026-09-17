require('./sqlite-env');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const directory = path.join(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, 'admin-' + crypto.randomUUID() + '.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.VIP_MEDIA_DRIVER = 'supabase';
process.env.ADMIN_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SUPABASE_URL = 'https://cms-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = crypto.randomBytes(32).toString('hex');
process.env.VIP_MEDIA_BUCKET = 'private-test';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.FRONTEND_URL = '';
const realFetch = global.fetch;
const remotes = new Map();
let storageCalls = 0;
let publicBucket = false;
let wrongLocation = false;
let loseResponse = false;
global.fetch = async (url, options = {}) => {
  if (!String(url).startsWith(process.env.SUPABASE_URL)) return realFetch(url, options);
  storageCalls++;
  assert.equal(options.headers.Authorization, 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY);
  const pathname = new URL(url).pathname;
  if (pathname.startsWith('/storage/v1/bucket/')) return Response.json({ public: publicBucket });
  if (pathname.includes('/object/sign/')) return Response.json({ signedURL: '/object/sign/private-test/mock?token=private-test-token' });
  if (options.method === 'POST') {
    const destination = process.env.SUPABASE_URL + '/storage/v1/upload/resumable/' + crypto.randomUUID();
    remotes.set(destination, { offset: 0, bytes: [] });
    return new Response(null, { status: 201, headers: { location: wrongLocation ? 'https://evil.example/upload' : destination } });
  }
  const remote = remotes.get(String(url)); assert.ok(remote);
  if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'upload-offset': String(remote.offset) } });
  assert.equal(options.method, 'PATCH');
  assert.equal(Number(options.headers['Upload-Offset']), remote.offset);
  remote.bytes.push(Buffer.from(options.body)); remote.offset += options.body.length;
  if (loseResponse) { loseResponse = false; throw new Error('simulated connection loss after server accepted chunk'); }
  return new Response(null, { status: 204, headers: { 'upload-offset': String(remote.offset) } });
};
const { app } = require('../server');
const { initDb, getDb, closeDb } = require('../db/database');
const postService = require('../services/vip-posts');
const { createOrder, updateOrderPayment } = require('../services/orders');
const { confirmPayment } = require('../services/entitlements');
let server, base, cookie, csrf;
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
async function request(route, { method = 'GET', body, headers = {}, authenticated = true } = {}) {
  const opts = { method, redirect: 'manual', headers: { ...(authenticated && cookie ? { Cookie: cookie, 'x-csrf-token': csrf || '' } : {}), ...headers } };
  if (method !== 'GET') opts.headers.Origin ??= base;
  if (body !== undefined) {
    opts.body = Buffer.isBuffer(body) ? body : JSON.stringify(body);
    opts.headers['Content-Type'] ??= Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
  }
  const response = await realFetch(base + route, opts);
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, headers: response.headers, data, text };
}
async function upload(bytes, mime) {
  const begin = await request('/api/admin/uploads', { method: 'POST', body: { size: bytes.length, mime } });
  assert.equal(begin.status, 201);
  const id = begin.data.id;
  for (let offset = 0; offset < bytes.length; offset += begin.data.chunkSize) {
    const sent = await request('/api/admin/uploads/' + id, { method: 'PATCH', headers: { 'upload-offset': String(offset) }, body: bytes.subarray(offset, offset + begin.data.chunkSize) });
    assert.equal(sent.status, 200, sent.text);
  }
  return id;
}
/**
 * JPEG sintético: cabeçalho real (SOI + SOF0 + EOI) com as dimensões pedidas.
 * Serve para exercitar a validação da derivada da HOME sem depender de
 * biblioteca de imagem nem de arquivo de exemplo no repositório.
 */
function tinyJpeg(width, height, padding = 0) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xFFC0, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.alloc(padding), Buffer.from([0xFF, 0xD9])]);
}
async function main() {
  await initDb(); await initDb();
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  process.env.ADMIN_ORIGIN = base;
  check((await request('/admin')).status === 303, 'admin page redirects unauthenticated visitors');
  check((await request('/admin/app.js')).status === 303, 'management script requires admin session');
  check((await request('/admin/login')).status === 200, 'login page available without content');
  check((await request('/api/admin/posts')).status === 401, 'post list denies anonymous access');
  check((await request('/api/admin/login', { method: 'POST', body: { secret: 'wrong' } })).status === 401, 'wrong secret denied');
  check((await request('/api/admin/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { secret: process.env.ADMIN_ACCESS_SECRET } })).status === 403, 'cross-origin login denied');
  const login = await request('/api/admin/login', { method: 'POST', body: { secret: process.env.ADMIN_ACCESS_SECRET } });
  check(login.status === 200, 'admin login succeeds');
  cookie = login.headers.get('set-cookie').split(';')[0];
  check(/HttpOnly/.test(login.headers.get('set-cookie')) && /SameSite=Strict/.test(login.headers.get('set-cookie')), 'HttpOnly strict cookie');
  const sess = await request('/api/admin/session'); csrf = sess.data.csrf;
  check(csrf.length === 64 && !sess.text.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), 'CSRF token supplied without Storage key');
  check((await request('/api/admin/feed-source', { method: 'POST', body: { source: 'managed' }, headers: { 'x-csrf-token': 'wrong' } })).status === 403, 'CSRF required on mutations');
  check((await request('/admin')).headers.get('content-security-policy').includes("frame-ancestors 'none'"), 'admin CSP blocks framing');
  check((await request('/api/admin/posts')).data.source === 'legacy', 'old feed remains default');
  const empty = await request('/api/admin/posts'); check(empty.data.posts.length === 0 && storageCalls === 0, 'no automatic migration or upload');
  check((await request('/api/admin/posts/disposable/permanent',{method:'DELETE',body:{version:1},authenticated:false})).status===401,'visitor cannot permanently delete');
  await (await getDb()).run("INSERT INTO vip_posts(id,type,media_path,media_driver) VALUES ('disposable','image','previews/disposable.jpg','local')");
  check((await request('/api/admin/posts/disposable/permanent',{method:'DELETE',body:{version:1},headers:{'x-csrf-token':'wrong'}})).status===403,'permanent delete requires CSRF');
  // Excluir de vez é a única acao sem volta: exige a confirmacao da tela.
  check((await request('/api/admin/posts/disposable/permanent',{method:'DELETE',body:{version:1}})).status===400,'permanent delete without confirmation is refused');
  check((await request('/api/admin/posts/disposable/permanent',{method:'DELETE',body:{version:1,confirm:'talvez'}})).status===400,'wrong confirmation is refused');
  check(Boolean(await (await getDb()).get("SELECT id FROM vip_posts WHERE id='disposable'")),'refused attempts delete nothing');
  check((await request('/api/admin/posts/disposable/permanent',{method:'DELETE',body:{version:1,confirm:'EXCLUIR'}})).data.deleted===true,'admin can permanently delete disposable post');
  check((await request('/api/admin/profile', { authenticated: false })).status === 401, 'profile requires admin');
  const initialProfile = (await request('/api/admin/profile')).data;
  check((await request('/api/admin/profile', { method: 'PUT', body: initialProfile, headers: { 'x-csrf-token': 'wrong' } })).status === 403, 'profile requires CSRF');
  check((await request('/api/admin/profile', { method: 'PUT', body: { ...initialProfile, bio: 'Bio pelo painel' } })).status === 200, 'profile saves through authenticated endpoint');
  check((await request('/api/profile', { authenticated: false })).data.bio === 'Bio pelo painel', 'public profile reflects admin edits');
  check((await request('/api/profile/media/avatar', { authenticated: false })).headers.get('location') === '/avatar.jpg', 'default avatar route');
  await (await getDb()).run('DELETE FROM creator_profiles');
  await require('./profile-contract')(await getDb());
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(100)]);
  publicBucket = true;
  check((await request('/api/admin/uploads', { method: 'POST', body: { size: png.length, mime: 'image/png' } })).status === 409, 'public bucket blocks uploads');
  publicBucket = false; wrongLocation = true;
  check((await request('/api/admin/uploads', { method: 'POST', body: { size: png.length, mime: 'image/png' } })).status === 502, 'foreign upload Location blocked');
  wrongLocation = false;
  const bad = await request('/api/admin/uploads', { method: 'POST', body: { size: 20, mime: 'image/png' } });
  check((await request('/api/admin/uploads/' + bad.data.id, { method: 'PATCH', headers: { 'upload-offset': '0' }, body: Buffer.alloc(20) })).status === 400, 'invalid media signature rejected');
  check((await request('/api/admin/uploads', { method: 'POST', body: { size: 30, mime: 'image/svg+xml' } })).status === 400, 'active SVG content rejected');
  const uploadId = await upload(png, 'image/png');
  const input = { caption: '<script>alert(1)</script> legenda', sort_order: 20, published: false, uploadId };
  const saved = await request('/api/admin/posts', { method: 'POST', body: input });
  check(saved.status === 201 && saved.data.media_path.startsWith('ayla/'), 'post created with generated private path');
  const id = saved.data.id;
  check((await request('/api/admin/posts', { method: 'POST', body: input })).data.id === id && (await postService.list()).length === 1, 'retry after create does not duplicate publication');
  check((await request('/api/admin/posts', { method: 'POST', body: { ...input, uploadId: undefined, media_path: '../../.env' } })).status === 400, 'browser cannot choose arbitrary media path');
  const token = crypto.randomBytes(32).toString('hex');
  const order = await createOrder(require('../products').ayla_monthly, token, 'mock');
  await updateOrderPayment(order.public_id, await require('../payments/mock-provider').createPixPayment({ orderId: order.public_id }));
  const viewer = route => request(route, { authenticated: false, headers: { Authorization: 'Bearer ' + token } });
  check((await request('/api/admin/posts', { authenticated: false, headers: { Authorization: 'Bearer ' + token } })).status === 401, 'buyer credential is not admin authentication');
  check((await viewer('/api/vip/' + order.public_id)).status === 403, 'unpaid buyer denied');
  await confirmPayment(order.public_id);
  await request('/api/admin/feed-source', { method: 'POST', body: { source: 'managed' } });
  check((await viewer('/api/vip/' + order.public_id)).data.feed.length === 0, 'draft not in buyer feed');
  const published = await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, published: true, version: 1 } });
  check(published.status === 200, 'publish succeeds');
  check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, version: 1 } })).status === 409, 'stale edit rejected');
  let feed = (await viewer('/api/vip/' + order.public_id)).data.feed;
  check(feed.length === 1 && feed[0].realLikes && feed[0].likes === 0, 'managed feed has real zero-based likes');
  // Curtidas exibidas inválidas não passam: o campo é inteiro a partir de zero.
  for (const invalid of [-1, 1.5, '10', 200000000]) {
    check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, published: true, likes_count: invalid, version: 2 } })).status === 400,
      `declared likes rejected: ${JSON.stringify(invalid)}`);
  }
  check(!JSON.stringify(feed).includes(published.data.media_path), 'buyer feed hides storage object path');
  const signed = feed[0].media;
  const delivered = await request(signed, { authenticated: false });
  check(delivered.status === 302, 'paid buyer signed link delivers private Storage URL');
  const likes = await Promise.all(Array.from({ length: 6 }, () => request(`/api/vip/${order.public_id}/posts/${id}/like`, { method: 'PUT', body: { liked: true }, authenticated: false, headers: { Authorization: 'Bearer ' + token } })));
  check(likes.every(r => r.status === 200), 'concurrent likes succeed');
  check((await viewer('/api/vip/' + order.public_id)).data.feed[0].likes === 1, 'repeated like is idempotent per order/post');
  const edited = await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, caption: 'Atualizada', published: true, sort_order: -5, version: 2 } });
  check(edited.status === 200 && edited.data.caption === 'Atualizada', 'caption and order edited');
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, published: false, version: 3 } });
  check((await request(signed, { authenticated: false })).status === 404, 'unpublish revokes application signed links');
  await request('/api/admin/posts/' + id, { method: 'DELETE', body: { version: 4 } });
  check((await viewer('/api/vip/' + order.public_id)).data.feed.length === 0, 'archive all does not reactivate legacy fallback');
  await request('/api/admin/posts/' + id + '/restore', { method: 'POST', body: { version: 5 } });
  const restored = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  check(restored.archived === 0 && restored.published === 0, 'archive restores as draft');
  // O feed legado da Ayla é VAZIO de propósito (nada de placeholder no código),
  // então a migração é exercitada com um feed antigo de mentira, só neste teste.
  require('../vip-content').posts.push(
    { id: 1, type: 'image', source: 'ayla/posts/legado-1.jpg', caption: 'Legado 1', likes: 4321, draft: false },
    { id: 2, type: 'video', source: 'ayla/posts/legado-2.mp4', caption: 'Legado 2', likes: 0, draft: true },
    { id: 5, type: 'cta', caption: 'Assine' });
  const before = storageCalls;
  const migration = await request('/api/admin/migrate', { method: 'POST', body: {} });
  check(migration.data.imported > 0 && storageCalls === before, 'migration only imports metadata, never bytes');
  check((await request('/api/admin/migrate', { method: 'POST', body: {} })).data.imported === 0, 'migration idempotent');
  // A migração agora PRESERVA o estado: rascunho continua rascunho, publicado
  // continua publicado e a contagem antiga vira `likes_count`.
  const legacySource = require('../vip-content').posts.filter(p => ['image', 'video'].includes(p.type));
  const migrated = (await postService.list()).filter(p => p.id.startsWith('legacy-'));
  check(migrated.length === legacySource.length, 'every legacy media post migrated');
  check(!migrated.some(p => ['legacy-5', 'legacy-16'].includes(p.id)), 'call-to-action blocks are not imported as posts');
  check(migrated.filter(p => p.published).length === legacySource.filter(p => !p.draft).length, 'migration preserves published state');
  check(migrated.every(p => p.likes_count === (legacySource.find(l => 'legacy-' + l.id === p.id).likes || 0)), 'migration preserves likes as the declared count');
  const stillEditable = migrated[0];
  const relabel = await request('/api/admin/posts/' + stillEditable.id, { method: 'PUT', body: { caption: 'Legado editado', sort_order: stillEditable.sort_order, published: true, show_as_preview: false, likes_count: 4321, version: stillEditable.version } });
  check(relabel.status === 200 && relabel.data.caption === 'Legado editado' && relabel.data.likes_count === 4321, 'migrated post is editable and its likes are changeable');
  // Determinístico: o mesmo número em duas leituras seguidas, sem aleatório.
  const legacyFeed = async () => (await viewer('/api/vip/' + order.public_id)).data.feed.find(p => p.id === stillEditable.id);
  check((await legacyFeed()).likes === 4321 && (await legacyFeed()).likes === 4321, 'declared likes are stable across loads');
  const archivedLegacy = await request('/api/admin/posts/' + stillEditable.id, { method: 'DELETE', body: { version: relabel.data.version } });
  check(archivedLegacy.status === 200, 'migrated post is archivable');
  await request('/api/admin/posts/' + stillEditable.id + '/restore', { method: 'POST', body: { version: relabel.data.version + 1 } });
  const big = Buffer.alloc(6 * 1024 * 1024 + 20); big.write('ftyp', 4, 'ascii');
  const begun = await request('/api/admin/uploads', { method: 'POST', body: { size: big.length, mime: 'video/mp4' } });
  const bigId = begun.data.id;
  let result = await request('/api/admin/uploads/' + bigId, { method: 'PATCH', body: big.subarray(0, 3 * 1024 * 1024), headers: { 'upload-offset': '0' } });
  check(result.status === 200 && result.data.offset === 3 * 1024 * 1024, 'first 3MB block persisted across requests');
  loseResponse = true;
  const second = { method: 'PATCH', body: big.subarray(3 * 1024 * 1024, 6 * 1024 * 1024), headers: { 'upload-offset': String(3 * 1024 * 1024) } };
  check((await request('/api/admin/uploads/' + bigId, second)).status === 500, 'simulated lost response fails without leaking upstream details');
  result = await request('/api/admin/uploads/' + bigId, second);
  check(result.status === 200 && result.data.offset === 6 * 1024 * 1024, 'retry reconciles remote offset after lost response');
  result = await request('/api/admin/uploads/' + bigId, { method: 'PATCH', body: big.subarray(6 * 1024 * 1024), headers: { 'upload-offset': String(6 * 1024 * 1024) } });
  check(result.data.complete, 'multi-request video upload completes');
  const bigRow = await (await getDb()).get('SELECT * FROM vip_uploads WHERE id=?', bigId);
  check(Buffer.concat(remotes.get(bigRow.remote_url).bytes).equals(big) && bigRow.pending_chunk === '', 'video reconstructed exactly and temporary bytes cleared');
  const changed = await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, uploadId: bigId, published: true, version: 6 } });
  check(changed.status === 200 && changed.data.type === 'video', 'replacing photo with video updates type');

  /* ---------------------------------------------- prévia bloqueada da HOME */
  const current = async () => (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  const home = () => request('/api/home/previews', { authenticated: false });
  // Sem uploadId: editar metadados não deve exigir reenviar a mídia.
  const edit = (extra) => request('/api/admin/posts/' + id, { method: 'PUT', body: { ...input, uploadId: undefined, published: true, ...extra } });
  check((await home()).data.previews.length === 0, 'home preview list empty before anything is marked');
  check((await edit({ show_as_preview: true, version: (await current()).version })).status === 400, 'marking HOME preview without a derivative is refused');
  const derivative = tinyJpeg(64, 80, 240).toString('base64');
  for (const [label, value] of [
    ['non-JPEG bytes', Buffer.from('not an image at all').toString('base64')],
    ['oversized dimensions', tinyJpeg(900, 1200, 60).toString('base64')],
    ['oversized file', tinyJpeg(64, 80, 40 * 1024).toString('base64')],
    ['non-base64 payload', 'data:image/svg+xml,<svg onload=alert(1)>']
  ]) {
    check((await edit({ preview_image: value, version: (await current()).version })).status === 400, `HOME derivative rejected: ${label}`);
  }
  const marked = await edit({ show_as_preview: true, preview_image: derivative, version: (await current()).version });
  check(marked.status === 200 && marked.data.show_as_preview === 1 && marked.data.has_preview === 1, 'post marked as HOME preview with a valid derivative');
  check(!marked.text.includes(derivative) && !(await request('/api/admin/posts')).text.includes(derivative), 'panel list does not resend the derivative payload');
  let shown = await home();
  check(shown.data.previews.length === 1 && shown.data.previews[0].preview === 'data:image/jpeg;base64,' + derivative, 'marked post appears on the HOME as a derivative');
  check(!shown.text.includes(marked.data.media_path) && !shown.text.includes('ayla/') && !shown.text.includes('media'),
    'HOME preview never carries the storage path or any media link');
  const paidFeed = async () => (await request('/api/vip/' + order.public_id, { authenticated: false, headers: { Authorization: 'Bearer ' + token } })).data.feed;
  const feedWithPreview = await paidFeed();
  await edit({ show_as_preview: false, version: (await current()).version });
  const feedWithout = await paidFeed();
  await edit({ show_as_preview: true, version: (await current()).version });
  check(feedWithPreview.length === feedWithout.length && feedWithPreview.some(p => p.id === id),
    'marking the HOME preview does not change the paid feed');
  await edit({ show_as_preview: true, published: false, version: (await current()).version });
  check((await home()).data.previews.length === 0, 'draft marked as preview stays off the HOME');
  await edit({ show_as_preview: true, version: (await current()).version });
  await request('/api/admin/posts/' + id, { method: 'DELETE', body: { version: (await current()).version } });
  check((await home()).data.previews.length === 0, 'archived post stays off the HOME');
  await request('/api/admin/posts/' + id + '/restore', { method: 'POST', body: { version: (await current()).version } });
  await edit({ show_as_preview: true, version: (await current()).version });
  check((await home()).data.previews.length === 1, 'republished preview returns to the HOME');
  await request('/api/admin/feed-source', { method: 'POST', body: { source: 'legacy' } });
  check((await home()).data.previews.length === 0, 'old feed mode shows no managed previews');
  await request('/api/admin/feed-source', { method: 'POST', body: { source: 'managed' } });
  const before503 = storageCalls;
  check((await home()).status === 200 && storageCalls === before503, 'public HOME previews never touch Storage');

  await (await getDb()).run("UPDATE entitlements SET status='EXPIRED' WHERE order_id=?", order.id);
  check((await viewer('/api/vip/' + order.public_id)).status === 403, 'expired entitlement denies managed feed');
  check((await request(signed, { authenticated: false })).status === 403, 'expired entitlement denies signed media');
  check((await request(`/api/vip/${order.public_id}/posts/${id}/like`, { method: 'PUT', body: { liked: true }, authenticated: false, headers: { Authorization: 'Bearer ' + token } })).status === 403, 'expired buyer cannot like');
  await request('/api/admin/logout', { method: 'POST', body: {} });
  check((await request('/api/admin/posts')).status === 401, 'logout revokes server-side session');
  check(!(await request('/backend/admin-ui/index.html')).text.includes('Seu conteúdo'), 'admin source inaccessible via static path');
  for (let n = 0; n < 12; n++) await request('/api/admin/login', { method: 'POST', body: { secret: 'wrong' }, authenticated: false });
  check((await request('/api/admin/login', { method: 'POST', body: { secret: 'wrong' }, authenticated: false })).status === 429, 'persistent login rate limit');
  console.log(`Admin/content: ${checks} checks passed. No real Storage upload or payment.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await closeDb(); global.fetch = realFetch;
});
