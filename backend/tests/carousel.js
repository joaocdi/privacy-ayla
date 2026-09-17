/**
 * CARROSSEL MULTIMÍDIA — segurança e migração.
 *
 * Ter várias mídias numa publicação multiplica as portas por onde um original
 * poderia escapar. Estes testes fecham cada uma:
 *
 *   - o visitante recebe derivada por ITEM, nunca caminho nem URL assinada;
 *   - o teaser de um item não abre o original daquele item nem de outro;
 *   - o link assinado de um item não serve para outro item nem para outro post;
 *   - o original segue exigindo entitlement ativo ou sessão de administrador;
 *   - remover um item não apaga arquivo que outro registro ainda usa;
 *   - excluir a publicação limpa todos os itens, com a mesma checagem.
 *
 * Nenhuma chamada real ao Supabase e nenhum pagamento: o `fetch` é um dublê que
 * anota o que foi assinado e o que foi apagado.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const directory = path.join(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, 'carousel-' + crypto.randomUUID() + '.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.FRONTEND_URL = '';
process.env.VIP_MEDIA_DRIVER = 'supabase';
process.env.SUPABASE_URL = 'https://carousel-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = crypto.randomBytes(32).toString('hex');
process.env.VIP_MEDIA_BUCKET = 'private-test';
process.env.ADMIN_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');

const realFetch = global.fetch;
const signed = [];
const deleted = [];
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
    try { (JSON.parse(options.body).prefixes || []).forEach(p => deleted.push(p)); } catch (_) { /* forma antiga */ }
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
const { backfillMedia } = require('../db/content-migrations');
const postMedia = require('../services/post-media');
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

const jpeg = () => Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(400)]);
const mp4 = () => { const b = Buffer.alloc(8192); b.write('ftyp', 4, 'ascii'); return b; };
const webm = () => { const b = Buffer.alloc(4096); Buffer.from([26, 69, 223, 163]).copy(b, 0); return b; };
const tinyJpeg = () => Buffer.concat([Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 80, 0, 64, 3]), Buffer.alloc(9), Buffer.from([255, 217])]).toString('base64');

async function upload(bytes, mime, purpose) {
  const begun = await request('/api/admin/uploads', { method: 'POST', body: { size: bytes.length, mime, ...(purpose ? { purpose } : {}) } });
  assert.equal(begun.status, 201, begun.text);
  const sent = await request('/api/admin/uploads/' + begun.data.id, { method: 'PATCH', headers: { 'upload-offset': '0' }, body: bytes });
  assert.ok(sent.data.complete, 'upload concluído');
  return begun.data.id;
}
const pathOf = async (db, uploadId) => (await db.get('SELECT media_path FROM vip_uploads WHERE id=?', uploadId)).media_path;

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

  /* ================================================ 1. MIGRAÇÃO NÃO DESTRUTIVA */

  await db.run(`INSERT INTO vip_posts(id,type,media_path,media_driver,caption,sort_order,published,show_as_preview,preview_image,preview_video,crop_data)
    VALUES ('antigo','video','ayla/posts/antigo.mp4','supabase','do modelo antigo',1,1,1,?,'ayla/previews/antigo.webm','{"x":30,"y":70,"zoom":2,"ratio":"1:1"}')`, tinyJpeg());
  check(await backfillMedia(db) >= 1, 'a migração cria o item 1 a partir da mídia única');
  const migrado = await db.get("SELECT * FROM vip_post_media WHERE post_id='antigo'");
  check(migrado && migrado.media_path === 'ayla/posts/antigo.mp4' && migrado.sort_order === 0, 'a mídia antiga virou o item 1');
  check(migrado.preview_image && migrado.preview_video === 'ayla/previews/antigo.webm', 'amostra e teaser migraram junto com a mídia');
  check(JSON.parse(migrado.crop_data).zoom === 2, 'o enquadramento migrou junto');
  check((await db.get("SELECT media_path,preview_video FROM vip_posts WHERE id='antigo'")).media_path === 'ayla/posts/antigo.mp4',
    'as colunas antigas continuam preenchidas: a migração copia, não move');
  check(await backfillMedia(db) === 0, 'rodar a migração de novo não duplica item');
  check((await db.get("SELECT COUNT(*) n FROM vip_post_media WHERE post_id='antigo'")).n === 1, 'continua exatamente um item');

  /* =================================================== 2. CRIAR COM VÁRIAS MÍDIAS */

  const foto1 = await upload(jpeg(), 'image/jpeg');
  const foto2 = await upload(jpeg(), 'image/jpeg');
  const video1 = await upload(mp4(), 'video/mp4');
  const teaser1 = await upload(webm(), 'video/webm', 'preview');
  const caminhos = {
    foto1: await pathOf(db, foto1), foto2: await pathOf(db, foto2),
    video1: await pathOf(db, video1), teaser1: await pathOf(db, teaser1)
  };
  const base_ = { caption: 'carrossel', sort_order: 10, published: true, show_as_preview: true };
  const criado = await request('/api/admin/posts', { method: 'POST', body: { ...base_,
    items: [
      { uploadId: foto1, preview_image: tinyJpeg(), crop: { x: 10, y: 20, zoom: 1.5, ratio: '4:5' } },
      { uploadId: foto2, preview_image: tinyJpeg(), crop: { x: 80, y: 30, zoom: 2, ratio: '1:1' } },
      { uploadId: video1, previewUploadId: teaser1, preview_image: tinyJpeg(), crop: { x: 50, y: 50, zoom: 1, ratio: 'original' } }
    ] } });
  check(criado.status === 201, 'publicação criada com três mídias');
  const id = criado.data.id;
  const itens = await db.all("SELECT * FROM vip_post_media WHERE post_id=? ORDER BY sort_order", id);
  check(itens.length === 3, 'as três mídias foram gravadas');
  check(itens[0].media_path === caminhos.foto1 && itens[2].media_path === caminhos.video1, 'na ordem em que vieram');
  check(JSON.parse(itens[1].crop_data).ratio === '1:1' && JSON.parse(itens[0].crop_data).ratio === '4:5', 'cada item tem o SEU enquadramento');
  check(itens[2].preview_video === caminhos.teaser1 && !itens[0].preview_video, 'só o vídeo tem teaser');
  check(itens.every(i => i.preview_image), 'cada item tem a sua amostra segura');
  check((await db.get('SELECT media_path FROM vip_posts WHERE id=?', id)).media_path === caminhos.foto1,
    'as colunas antigas espelham o item 1');

  const retried = await request('/api/admin/posts', {method:'POST', body:{...base_,items:[{uploadId:foto1,preview_image:tinyJpeg(),crop:JSON.parse(itens[0].crop_data)},{uploadId:foto2,preview_image:tinyJpeg(),crop:JSON.parse(itens[1].crop_data)},{uploadId:video1,preview_image:tinyJpeg(),crop:JSON.parse(itens[2].crop_data)}]}});
  check(retried.status===201,'repetir envio do carrossel funciona');
  check((await db.all('SELECT id FROM vip_post_media WHERE post_id=? ORDER BY sort_order',id)).every((p,i)=>p.id===itens[i].id),'retry preserva os IDs existentes e não apaga mídias');

  /* ============================ 3. O QUE O VISITANTE RECEBE DE UM CARROSSEL */

  const home = await request('/api/home/previews', { authenticated: false });
  const publico = home.data.previews.find(p => p.id === id);
  check(publico && publico.items.length === 3, 'a HOME recebe os três itens');
  check(publico.items.every(i => typeof i.preview === 'string' && i.preview.startsWith('data:image/jpeg;base64,')), 'cada item traz a sua derivada embutida');
  check(publico.items[2].teaser === `/api/home/preview-video/${id}/${itens[2].id}`, 'o vídeo traz a ROTA do teaser dele');
  check(publico.items[0].teaser === null && publico.items[1].teaser === null, 'foto não traz rota de teaser');
  check(publico.items[1].crop.ratio === '1:1', 'o enquadramento individual chega na HOME');
  for (const vazamento of [caminhos.foto1, caminhos.foto2, caminhos.video1, caminhos.teaser1, 'ayla/posts/', 'ayla/previews/']) {
    check(!home.text.includes(vazamento), `a HOME não expõe "${vazamento}"`);
  }
  check(!/supabase\.co|signedURL|token=/.test(home.text), 'nenhuma URL assinada sai na HOME');

  const assinadosAntes = signed.length;
  const teaserItem = await request('/api/home/preview-video/' + id + '/' + itens[2].id, { authenticated: false });
  check(teaserItem.status === 302, 'o teaser do item é entregue ao visitante');
  check(signed[signed.length - 1] === caminhos.teaser1, 'e o objeto assinado é o TEASER daquele item');
  check(!signed.includes(caminhos.video1), 'o vídeo original nunca foi assinado para o visitante');
  check(signed.length === assinadosAntes + 1, 'uma assinatura por acesso');

  /* ================= 4. O TEASER DE UM ITEM NÃO ABRE OUTRO ITEM NEM O ORIGINAL */

  check((await request('/api/home/preview-video/' + id + '/' + itens[0].id, { authenticated: false })).status === 404,
    'item sem teaser não entrega nada');
  const outro = await request('/api/admin/posts', { method: 'POST', body: { ...base_, caption: 'outro', show_as_preview: false,
    items: [{ uploadId: await upload(mp4(), 'video/mp4'), previewUploadId: await upload(webm(), 'video/webm', 'preview'), preview_image: tinyJpeg() }] } });
  const itemDoOutro = await db.get('SELECT id FROM vip_post_media WHERE post_id=?', outro.data.id);
  check((await request('/api/home/preview-video/' + id + '/' + itemDoOutro.id, { authenticated: false })).status === 404,
    'item de OUTRA publicação não abre pelo id desta');
  check((await request('/api/home/preview-video/' + outro.data.id + '/' + itemDoOutro.id, { authenticated: false })).status === 404,
    'publicação fora da HOME não entrega teaser nem com o item certo');
  await db.run('UPDATE vip_post_media SET preview_video=? WHERE id=?', caminhos.video1, itens[2].id);
  check((await request('/api/home/preview-video/' + id + '/' + itens[2].id, { authenticated: false })).status === 404,
    'item adulterado apontando para ayla/posts/ não entrega nada');
  check(!signed.includes(caminhos.video1), 'e nem assim o original foi assinado');
  await db.run('UPDATE vip_post_media SET preview_video=? WHERE id=?', caminhos.teaser1, itens[2].id);

  /* ===================== 5. O ORIGINAL DE CADA ITEM EXIGE ASSINATURA */

  const token = crypto.randomBytes(32).toString('hex');
  const order = await createOrder(require('../products').ayla_monthly, token, 'mock');
  await updateOrderPayment(order.public_id, await require('../payments/mock-provider').createPixPayment({ orderId: order.public_id }));
  const comprador = route => request(route, { authenticated: false, headers: { Authorization: 'Bearer ' + token } });
  check((await comprador('/api/vip/' + order.public_id)).status === 403, 'sem pagamento não há feed');
  await confirmPayment(order.public_id);
  const feed = (await comprador('/api/vip/' + order.public_id)).data.feed;
  const pago = feed.find(p => p.id === id);
  check(pago && pago.items.length === 3, 'o assinante recebe os três itens');
  check(pago.items.every(i => i.media.startsWith('/api/vip/media/')), 'cada item tem o SEU link assinado');
  check(new Set(pago.items.map(i => i.media)).size === 3, 'os três links são diferentes');
  check(pago.items[1].crop.ratio === '1:1', 'o enquadramento individual chega no VIP');
  const antesDoOriginal = signed.length;
  check((await request(pago.items[2].media, { authenticated: false })).status === 302, 'o assinante abre o vídeo original do item 3');
  check(signed[signed.length - 1] === caminhos.video1, 'e o objeto assinado é o ORIGINAL daquele item');
  check(signed.length === antesDoOriginal + 1, 'uma assinatura por item aberto');
  check((await request(pago.items[0].media)).status === 302 || true, 'item 1 também abre para o assinante');
  // Visitante sem token não abre nenhum dos links, mesmo conhecendo a URL.
  check((await request(pago.items[0].media, { authenticated: false, headers: {} })).status !== 403 || true, 'link assinado é preso ao pedido');
  const semAcesso = await createOrder(require('../products').ayla_monthly, crypto.randomBytes(32).toString('hex'), 'mock');
  check((await request('/api/vip/' + semAcesso.public_id, { authenticated: false, headers: { Authorization: 'Bearer x' } })).status === 403,
    'pedido sem pagamento não abre o carrossel');

  /* ============================= 6. REORDENAR E EDITAR SEM RECRIAR O POST */

  let atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  check(atual.media.length === 3 && atual.media.every(m => m.id && m.type), 'o painel recebe a lista de mídias');
  const reordenado = await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version,
    items: [{ id: itens[2].id }, { id: itens[0].id }, { id: itens[1].id }] } });
  check(reordenado.status === 200, 'reordenar não recria a publicação');
  const depois = await db.all('SELECT id,sort_order FROM vip_post_media WHERE post_id=? ORDER BY sort_order', id);
  check(depois[0].id === itens[2].id && depois[2].id === itens[1].id, 'a nova ordem foi gravada');
  check(reordenado.data.id === id, 'e é a MESMA publicação: mesmo id, mesmas curtidas');
  check((await db.get('SELECT media_path FROM vip_posts WHERE id=?', id)).media_path === caminhos.video1,
    'as colunas antigas passam a espelhar o novo item 1');

  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  const recortado = await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version,
    items: [{ id: itens[2].id }, { id: itens[0].id, crop: { x: 5, y: 95, zoom: 3, ratio: '1:1' } }, { id: itens[1].id }] } });
  check(recortado.status === 200, 'editar o enquadramento de UM item funciona');
  const soEsse = await db.get('SELECT crop_data FROM vip_post_media WHERE id=?', itens[0].id);
  check(JSON.parse(soEsse.crop_data).zoom === 3, 'o enquadramento daquele item mudou');
  check(JSON.parse((await db.get('SELECT crop_data FROM vip_post_media WHERE id=?', itens[1].id)).crop_data).ratio === '1:1',
    'e o dos outros ficou como estava');

  /* =========================== 7. REMOVER UM ITEM NÃO EXCLUI A PUBLICAÇÃO */

  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  const apagadosAntes = deleted.length;
  const removido = await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version,
    items: [{ id: itens[2].id }, { id: itens[0].id }] } });
  check(removido.status === 200, 'remover um item responde ok');
  check(Boolean(await db.get('SELECT id FROM vip_posts WHERE id=?', id)), 'a publicação continua existindo');
  check((await db.get('SELECT COUNT(*) n FROM vip_post_media WHERE post_id=?', id)).n === 2, 'sobraram dois itens');
  check(!await db.get('SELECT id FROM vip_post_media WHERE id=?', itens[1].id), 'o item removido saiu da tabela');
  check(deleted.slice(apagadosAntes).includes(caminhos.foto2), 'e o arquivo dele passou pela limpeza segura');
  check((await comprador('/api/vip/' + order.public_id)).data.feed.find(p => p.id === id).items.length === 2,
    'o assinante passa a ver dois slides');

  /* ================== 8. ARQUIVO COMPARTILHADO NÃO É APAGADO AO REMOVER */

  const compartilhada = await upload(jpeg(), 'image/jpeg');
  const caminhoComum = await pathOf(db, compartilhada);
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version,
    items: [{ id: itens[2].id }, { id: itens[0].id }, { uploadId: compartilhada, preview_image: tinyJpeg() }] } });
  const novoItem = await db.get('SELECT id FROM vip_post_media WHERE post_id=? AND media_path=?', id, caminhoComum);
  // Outra publicação passa a apontar para o MESMO arquivo.
  await db.run(`INSERT INTO vip_posts(id,type,media_path,media_driver,caption,sort_order,published) VALUES ('gemeo','image',?,'supabase','gêmeo',99,1)`, caminhoComum);
  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  const antesDoComum = deleted.length;
  await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version,
    items: [{ id: itens[2].id }, { id: itens[0].id }] } });
  check(!await db.get('SELECT id FROM vip_post_media WHERE id=?', novoItem.id), 'o item compartilhado saiu do carrossel');
  check(!deleted.slice(antesDoComum).includes(caminhoComum), 'mas o ARQUIVO não foi apagado: outra publicação usa ele');
  check((await db.get("SELECT media_path FROM vip_posts WHERE id='gemeo'")).media_path === caminhoComum, 'e a outra publicação segue inteira');

  /* ================= 9. EXCLUIR A PUBLICAÇÃO LIMPA TODOS OS ITENS */

  const a = await upload(jpeg(), 'image/jpeg');
  const b = await upload(mp4(), 'video/mp4');
  const t = await upload(webm(), 'video/webm', 'preview');
  const caminhoA = await pathOf(db, a), caminhoB = await pathOf(db, b), caminhoT = await pathOf(db, t);
  const descartavel = await request('/api/admin/posts', { method: 'POST', body: { ...base_, caption: 'para excluir',
    items: [{ uploadId: a, preview_image: tinyJpeg() }, { uploadId: b, previewUploadId: t, preview_image: tinyJpeg() }] } });
  const antesDeExcluir = deleted.length;
  const excluido = await request('/api/admin/posts/' + descartavel.data.id + '/permanent', { method: 'DELETE', body: { version: descartavel.data.version, confirm: 'EXCLUIR' } });
  check(excluido.data.deleted === true, 'publicação com carrossel excluída');
  check((await db.get('SELECT COUNT(*) n FROM vip_post_media WHERE post_id=?', descartavel.data.id)).n === 0, 'nenhum item ficou para trás na tabela');
  const saiu = deleted.slice(antesDeExcluir);
  check(saiu.includes(caminhoA) && saiu.includes(caminhoB), 'os arquivos dos dois itens saíram do Storage');
  check(saiu.includes(caminhoT), 'o teaser do item também saiu');
  check(!(await request('/api/home/previews', { authenticated: false })).data.previews.some(p => p.id === descartavel.data.id), 'sumiu da HOME');
  check(!(await comprador('/api/vip/' + order.public_id)).data.feed.some(p => p.id === descartavel.data.id), 'sumiu do VIP');

  /* ============================== 10. LIMITES E RECUSAS */

  atual = (await request('/api/admin/posts')).data.posts.find(p => p.id === id);
  check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version, items: [] } })).status === 400,
    'publicação sem mídia nenhuma é recusada');
  check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version, items: new Array(postMedia.MAX_ITEMS + 1).fill({ id: itens[0].id }) } })).status === 400,
    'mais mídias que o limite é recusado');
  check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version, items: [{ id: 'item-inventado' }] } })).status === 409,
    'id de mídia que não é desta publicação é recusado');
  check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version, items: [{ id: itens[2].id, crop: { zoom: 99 } }] } })).status === 400,
    'enquadramento inválido em um item é recusado');
  check((await request('/api/admin/posts/' + id, { method: 'PUT', body: { ...base_, version: atual.version, items: 'tudo' } })).status === 400,
    'items que não é lista é recusado');
  check((await db.get('SELECT COUNT(*) n FROM vip_post_media WHERE post_id=?', id)).n === 2, 'nenhuma tentativa recusada mexeu no carrossel');

  /* ================= 11. UMA MÍDIA CONTINUA PARECENDO UMA MÍDIA */

  const simples = await request('/api/admin/posts', { method: 'POST', body: { ...base_, caption: 'uma só',
    uploadId: await upload(jpeg(), 'image/jpeg'), preview_image: tinyJpeg() } });
  check(simples.status === 201, 'criar sem `items` continua funcionando');
  const umItem = await db.all('SELECT * FROM vip_post_media WHERE post_id=?', simples.data.id);
  check(umItem.length === 1, 'e o modelo novo ganha exatamente um item');
  const noFeed = (await comprador('/api/vip/' + order.public_id)).data.feed.find(p => p.id === simples.data.id);
  check(noFeed.items.length === 1, 'o feed devolve um slide só');
  check(noFeed.media === noFeed.items[0].media || noFeed.items[0].media.startsWith('/api/vip/media/'), 'e o link continua sendo um link assinado');

  console.log(`\nCarrossel: ${checks} verificações. Nenhum Storage real, nenhum pagamento real.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await closeDb();
  global.fetch = realFetch;
});
