/**
 * TEASER DE VÍDEO DA HOME — segurança.
 *
 * O que estes testes tentam provar é uma coisa só, por vários ângulos: o
 * visitante da HOME recebe um arquivo DERIVADO e nada além disso. O original
 * continua atrás de assinatura ativa ou sessão de administrador, e nenhum
 * caminho, link assinado ou truque de URL transforma a prévia em acesso VIP.
 *
 * Nenhuma chamada real ao Supabase e nenhum pagamento: o `fetch` é um dublê
 * que anota quais objetos foram assinados e quais foram apagados.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const directory = path.join(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, 'teaser-' + crypto.randomUUID() + '.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.FRONTEND_URL = '';
process.env.VIP_MEDIA_DRIVER = 'supabase';
process.env.SUPABASE_URL = 'https://teaser-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = crypto.randomBytes(32).toString('hex');
process.env.VIP_MEDIA_BUCKET = 'private-test';
process.env.ADMIN_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');

const realFetch = global.fetch;
const signed = [];          // objetos para os quais pedimos URL assinada
const deleted = [];         // objetos apagados do Storage
const remotes = new Map();
global.fetch = async (url, options = {}) => {
  const address = String(url);
  if (!address.startsWith(process.env.SUPABASE_URL)) return realFetch(url, options);
  const { pathname } = new URL(address);
  if (pathname.startsWith('/storage/v1/bucket/')) return Response.json({ public: false });
  if (pathname.includes('/object/sign/')) {
    signed.push(decodeURIComponent(pathname.replace('/storage/v1/object/sign/private-test/', '')));
    return Response.json({ signedURL: '/object/sign/private-test/x?token=assinado' });
  }
  if (options.method === 'DELETE') {
    // O Storage apaga por lista de prefixos no corpo, não pelo caminho na URL.
    try { (JSON.parse(options.body).prefixes || []).forEach(p => deleted.push(p)); }
    catch (_) { deleted.push(decodeURIComponent(pathname.replace('/storage/v1/object/private-test/', ''))); }
    return new Response('{}', { status: 200 });
  }
  if (options.method === 'POST') {
    const destination = process.env.SUPABASE_URL + '/storage/v1/upload/resumable/' + crypto.randomUUID();
    remotes.set(destination, { offset: 0 });
    return new Response(null, { status: 201, headers: { location: destination } });
  }
  const remote = remotes.get(address);
  if (!remote) return new Response('{}', { status: 200 });
  if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'upload-offset': String(remote.offset) } });
  remote.offset += options.body.length;
  return new Response(null, { status: 204, headers: { 'upload-offset': String(remote.offset) } });
};

const { app } = require('../server');
const { initDb, getDb, closeDb } = require('../db/database');
const posts = require('../services/vip-posts');
const previewVideo = require('../services/preview-video');
const { createOrder, updateOrderPayment } = require('../services/orders');
const { confirmPayment } = require('../services/entitlements');

let server, base, cookie, csrf;
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }

async function request(route, { method = 'GET', body, headers = {}, authenticated = true } = {}) {
  const options = { method, redirect: 'manual', headers: { ...headers } };
  if (authenticated && cookie) options.headers.Cookie = cookie;
  if (method !== 'GET') { options.headers.Origin ??= base; options.headers['x-csrf-token'] ??= csrf; }
  if (body !== undefined) {
    options.body = Buffer.isBuffer(body) ? body : JSON.stringify(body);
    options.headers['Content-Type'] ??= Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
  }
  const response = await realFetch(base + route, options);
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, headers: response.headers, data, text };
}

/** Um WebM mínimo: só os bytes mágicos que o servidor confere. */
function webm(size = 4096) {
  const bytes = Buffer.alloc(size);
  Buffer.from([26, 69, 223, 163]).copy(bytes, 0);
  return bytes;
}
function mp4(size = 4096) {
  const bytes = Buffer.alloc(size);
  bytes.write('ftyp', 4, 'ascii');
  return bytes;
}
async function upload(bytes, mime, purpose) {
  const begun = await request('/api/admin/uploads', { method: 'POST', body: { size: bytes.length, mime, ...(purpose ? { purpose } : {}) } });
  if (begun.status !== 201) return { error: begun };
  const sent = await request('/api/admin/uploads/' + begun.data.id, { method: 'PATCH', headers: { 'upload-offset': '0' }, body: bytes });
  assert.ok(sent.data.complete, 'upload de apoio concluído');
  return { id: begun.data.id };
}

async function main() {
  await initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  process.env.ADMIN_ORIGIN = base;
  const db = await getDb();

  const login = await request('/api/admin/login', { method: 'POST', body: { secret: process.env.ADMIN_ACCESS_SECRET }, authenticated: false, headers: { Origin: base } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await request('/api/admin/session')).data.csrf;
  await request('/api/admin/feed-source', { method: 'POST', body: { source: 'managed' } });

  /* ================================== 1. O TEASER NASCE EM CAMINHO PRÓPRIO */

  const original = await upload(mp4(8192), 'video/mp4');
  const teaser = await upload(webm(), 'video/webm', 'preview');
  const originalPath = (await db.get('SELECT media_path FROM vip_uploads WHERE id=?', original.id)).media_path;
  const teaserPath = (await db.get('SELECT media_path FROM vip_uploads WHERE id=?', teaser.id)).media_path;
  check(originalPath.startsWith('ayla/posts/'), 'o original vai para ayla/posts/');
  check(teaserPath.startsWith('ayla/previews/'), 'o teaser vai para ayla/previews/');
  check(originalPath !== teaserPath, 'teaser e original são arquivos diferentes');
  check(previewVideo.isPreviewPath(teaserPath) && !previewVideo.isPreviewPath(originalPath), 'só o caminho de prévia passa no teste de prefixo');

  const grande = await upload(webm(16), 'video/webm', 'preview');
  check((await request('/api/admin/uploads', { method: 'POST', body: { size: previewVideo.MAX_BYTES + 1, mime: 'video/webm', purpose: 'preview' } })).status === 400,
    'teaser acima do limite é recusado no início do upload');
  check((await request('/api/admin/uploads', { method: 'POST', body: { size: 4096, mime: 'image/jpeg', purpose: 'preview' } })).status === 400,
    'teaser precisa ser vídeo');

  const amostra = Buffer.concat([Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 80, 0, 64, 3]), Buffer.alloc(9), Buffer.from([255, 217])]).toString('base64');
  const base_ = { caption: 'vídeo com teaser', sort_order: 10, published: true, show_as_preview: true, preview_image: amostra };
  const created = await request('/api/admin/posts', { method: 'POST', body: { ...base_, uploadId: original.id, previewUploadId: teaser.id } });
  check(created.status === 201, 'publicação de vídeo criada com teaser');
  const id = created.data.id;
  check((await db.get('SELECT preview_video FROM vip_posts WHERE id=?', id)).preview_video === teaserPath, 'o teaser ficou gravado na publicação');

  /* ============================= 2. O QUE O VISITANTE RECEBE (E NÃO RECEBE) */

  const home = await request('/api/home/previews', { authenticated: false });
  const item = home.data.previews.find(p => p.id === id);
  check(Boolean(item), 'o vídeo aparece na prévia pública da HOME');
  check(item.teaser === '/api/home/preview-video/' + id, 'a HOME recebe a ROTA do teaser, não um caminho de arquivo');
  check(item.teaserSeconds === previewVideo.SECONDS, 'a HOME recebe a duração do teaser');
  // Contrato dos 7 segundos: alvo do backend, gravação do painel, tolerância
  // do validador e a parada do lado do navegador.
  const fs2 = require('fs'), path2 = require('path');
  const raiz = path2.resolve(__dirname, '..', '..');
  const painel = fs2.readFileSync(path2.join(raiz, 'admin-mode.js'), 'utf8');
  const homeJs = fs2.readFileSync(path2.join(raiz, 'app.js'), 'utf8');
  check(previewVideo.SECONDS === 7, 'o alvo do teaser é 7 segundos');
  check(previewVideo.MAX_SECONDS >= 7 && previewVideo.MAX_SECONDS <= 9, 'a tolerância acompanha os 7 segundos');
  check(/TEASER = \{ seconds: 7\b/.test(painel), 'o painel grava 7 segundos');
  check(/video\.loop = false/.test(homeJs) && /currentTime >= limit/.test(homeJs) && /'ended', finish/.test(homeJs),
    'o navegador toca uma passada só e volta ao cartão bloqueado');
  check(!home.text.includes(originalPath), 'a resposta pública NÃO contém o media_path do original');
  check(!home.text.includes(teaserPath), 'a resposta pública nem o caminho do teaser expõe');
  check(!home.text.includes('ayla/posts/'), 'nenhum caminho do bucket de originais sai na HOME');
  check(!/supabase\.co|signedURL|token=/.test(home.text), 'nenhuma URL assinada sai na HOME');

  const assinadosAntes = signed.length;
  const entrega = await request('/api/home/preview-video/' + id, { authenticated: false });
  check(entrega.status === 302, 'o teaser é entregue ao visitante sem sessão nenhuma');
  check(signed.length === assinadosAntes + 1 && signed[signed.length - 1] === teaserPath,
    'o objeto assinado para a HOME é o TEASER, nunca o original');
  check(!signed.includes(originalPath), 'o original nunca teve URL assinada para o visitante');
  check(!entrega.text.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), 'a entrega não vaza a chave do Storage');

  /* ================== 3. O TEASER NÃO É UMA PORTA PARA A ÁREA VIP */

  check((await request('/api/vip/' + id, { authenticated: false })).status === 403, 'o id do post não abre a área VIP');
  check((await request('/api/vip/preview', { authenticated: false })).status === 403, 'visitante não entra pela revisão administrativa');
  for (const truque of [
    encodeURIComponent(originalPath),
    '..%2F..%2F' + encodeURIComponent(originalPath),
    id + '%2F..%2F' + id
  ]) {
    const tentativa = await request('/api/home/preview-video/' + truque, { authenticated: false });
    check([404, 400, 403].includes(tentativa.status), `caminho forjado recusado (${tentativa.status})`);
  }
  // Registro adulterado apontando a coluna do teaser para o original.
  await db.run('UPDATE vip_posts SET preview_video=? WHERE id=?', originalPath, id);
  const adulterado = await request('/api/home/preview-video/' + id, { authenticated: false });
  check(adulterado.status === 404, 'registro apontando para ayla/posts/ não entrega nada');
  check(!signed.includes(originalPath), 'e nem assim o original foi assinado');
  await db.run('UPDATE vip_posts SET preview_video=? WHERE id=?', teaserPath, id);

  /* ===================== 4. O ORIGINAL CONTINUA EXIGINDO ASSINATURA */

  const token = crypto.randomBytes(32).toString('hex');
  const order = await createOrder(require('../products').ayla_monthly, token, 'mock');
  await updateOrderPayment(order.public_id, await require('../payments/mock-provider').createPixPayment({ orderId: order.public_id }));
  const comprador = route => request(route, { authenticated: false, headers: { Authorization: 'Bearer ' + token } });
  check((await comprador('/api/vip/' + order.public_id)).status === 403, 'sem pagamento não há feed');
  await confirmPayment(order.public_id);
  const feed = (await comprador('/api/vip/' + order.public_id)).data.feed;
  const pago = feed.find(p => p.id === id);
  check(Boolean(pago) && pago.media.startsWith('/api/vip/media/'), 'o assinante recebe o link assinado do ORIGINAL');
  check(pago.media !== item.teaser, 'o link do assinante é diferente da rota do teaser');
  const antesDoOriginal = signed.length;
  check((await request(pago.media, { authenticated: false })).status === 302, 'o assinante abre o original');
  check(signed[signed.length - 1] === originalPath, 'e aí sim o objeto assinado é o original');
  check(signed.length === antesDoOriginal + 1, 'uma assinatura por acesso, nada em lote');

  /* ===================== 5. PRÉVIA DESLIGADA FECHA A PORTA DO TEASER */

  let atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, show_as_preview: false, version: atual.version } });
  check((await request('/api/home/preview-video/' + id, { authenticated: false })).status === 404, 'tirar da HOME fecha a rota do teaser');
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, published: false, show_as_preview: true, version: atual.version } });
  check((await request('/api/home/preview-video/' + id, { authenticated: false })).status === 404, 'rascunho não entrega teaser');
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version } });
  check((await request('/api/home/preview-video/' + id, { authenticated: false })).status === 302, 'republicada, o teaser volta');

  /* ===================== 6. TROCAR A MÍDIA INVALIDA O TEASER ANTIGO */

  const novoOriginal = await upload(mp4(8192), 'video/mp4');
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  const apagadosAntes = deleted.length;
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, uploadId: novoOriginal.id, version: atual.version } });
  check((await db.get('SELECT preview_video FROM vip_posts WHERE id=?', id)).preview_video === null,
    'trocar a mídia zera o teaser: ele mostrava o vídeo antigo');
  check((await request('/api/home/preview-video/' + id, { authenticated: false })).status === 404, 'e a rota do teaser antigo para de responder');
  check(deleted.includes(teaserPath), 'o teaser antigo foi apagado do Storage');
  check(!deleted.includes(originalPath), 'trocar a mídia não apaga o original antigo por conta própria');
  check(deleted.length > apagadosAntes, 'a fila de limpeza agiu');

  const teaserNovo = await upload(webm(), 'video/webm', 'preview');
  const caminhoNovo = (await db.get('SELECT media_path FROM vip_uploads WHERE id=?', teaserNovo.id)).media_path;
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, previewUploadId: teaserNovo.id, version: atual.version } });
  check((await db.get('SELECT preview_video FROM vip_posts WHERE id=?', id)).preview_video === caminhoNovo, 'teaser novo entra no lugar');
  check((await request('/api/home/preview-video/' + id, { authenticated: false })).status === 302, 'e a HOME volta a entregar');

  /* ======================== 7. TEASER COMPARTILHADO NÃO É APAGADO */

  await db.run(`INSERT INTO vip_posts(id,type,media_path,media_driver,caption,sort_order,published,preview_video)
    VALUES ('gemeo','video','ayla/posts/outro.mp4','supabase','gêmeo',99,1,?)`, caminhoNovo);
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  const antesDeExcluir = deleted.length;
  const excluido = await request('/api/admin/posts/' + id + '/permanent', { method: 'DELETE', body: { version: atual.version, confirm: 'EXCLUIR' } });
  check(excluido.data.deleted === true, 'publicação excluída');
  check(excluido.data.teaser === 'none', 'o teaser compartilhado não entrou na limpeza');
  check(!deleted.slice(antesDeExcluir).includes(caminhoNovo), 'e o arquivo do teaser continua no Storage');
  check((await db.get("SELECT preview_video FROM vip_posts WHERE id='gemeo'")).preview_video === caminhoNovo, 'a outra publicação segue com o teaser dela');

  /* ======================== 8. EXCLUSÃO LIMPA O TEASER EXCLUSIVO */

  const soDela = await upload(webm(), 'video/webm', 'preview');
  const caminhoSoDela = (await db.get('SELECT media_path FROM vip_uploads WHERE id=?', soDela.id)).media_path;
  const ultimoOriginal = await upload(mp4(8192), 'video/mp4');
  const sozinho = await request('/api/admin/posts', { method: 'POST', body: { ...base_, uploadId: ultimoOriginal.id, previewUploadId: soDela.id } });
  const antesDoFim = deleted.length;
  const fim = await request('/api/admin/posts/' + sozinho.data.id + '/permanent', { method: 'DELETE', body: { version: sozinho.data.version, confirm: 'EXCLUIR' } });
  check(fim.data.teaser === 'done', 'a exclusão limpou o teaser');
  check(deleted.slice(antesDoFim).includes(caminhoSoDela), 'o arquivo do teaser saiu do Storage');
  check((await db.get('SELECT COUNT(*) AS n FROM media_deletions WHERE media_path=?', caminhoSoDela)).n === 1, 'a fila media_deletions registrou o teaser');
  check(!(await db.get('SELECT COUNT(*) AS n FROM media_deletions WHERE media_path LIKE ?', 'ayla/posts/%')).n
    || (await db.all("SELECT media_path FROM media_deletions WHERE media_path LIKE 'ayla/previews/%'")).length > 0,
  'a fila separa original de derivada');

  /* ======================== 9. FOTO NÃO GANHA TEASER */

  const foto = await upload(Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(200)]), 'image/jpeg');
  const teaserSolto = await upload(webm(), 'video/webm', 'preview');
  const imagem = await request('/api/admin/posts', { method: 'POST', body: { ...base_, uploadId: foto.id, previewUploadId: teaserSolto.id } });
  check((await db.get('SELECT preview_video FROM vip_posts WHERE id=?', imagem.data.id)).preview_video === null, 'publicação de foto não guarda teaser');
  const previewsFoto = (await request('/api/home/previews', { authenticated: false })).data.previews.find(p => p.id === imagem.data.id);
  check(previewsFoto && previewsFoto.teaser === null, 'e a HOME não recebe rota de teaser para foto');

  /* ======================== 10. UPLOAD DE TEASER FORA DA PASTA */

  const forjado = await upload(webm(), 'video/webm');            // sem purpose: vai para ayla/posts/
  const ultimo = await upload(mp4(8192), 'video/mp4');
  const recusado = await request('/api/admin/posts', { method: 'POST', body: { ...base_, uploadId: ultimo.id, previewUploadId: forjado.id } });
  check(recusado.status === 400, 'teaser enviado para a pasta de originais é recusado como teaser');

  console.log(`\nTeaser de vídeo: ${checks} verificações. Nenhum Storage real, nenhum pagamento real.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await closeDb();
  global.fetch = realFetch;
});
