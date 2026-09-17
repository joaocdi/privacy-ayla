/**
 * ÁREA VIP — autorização e entrega.
 *
 * O que precisa ser verdade, em ordem de gravidade:
 *  1. ninguém entra sem assinatura ativa;
 *  2. a mídia paga não existe em URL estática;
 *  3. o endpoint não devolve dado pessoal.
 *
 * Provider mock, banco temporário, nenhuma cobrança.
 */
require('./sqlite-env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');

const directory = path.resolve(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, 'vip-' + crypto.randomUUID() + '.sqlite');
process.env.PAYMENT_PROVIDER = 'mock';
process.env.NODE_ENV = 'test';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.FRONTEND_URL = 'http://localhost:5500';

// Mídia de teste dentro de uma pasta privada só deste teste.
const ROOT = path.resolve(__dirname, '..', '..');
const FOLDER = '__vip_test_media';
const MEDIA_DIR = path.join(ROOT, FOLDER);
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.writeFileSync(path.join(MEDIA_DIR, 'segredo.jpg'), 'CONTEUDO-PAGO-SECRETO');
process.env.VIP_MEDIA_DIRS = FOLDER;

const vipContent = require('../vip-content');
vipContent.posts.length = 0;
vipContent.posts.push(
  { id: 1, type: 'image', source: `${FOLDER}/segredo.jpg`, caption: 'post de teste', likes: 10, comments: 2 },
  { id: 2, type: 'image', source: `${FOLDER}/nao-existe.jpg`, caption: 'vaga vazia', likes: 0, comments: 0 },
  { id: 3, type: 'cta', variant: 'whatsapp', title: 'titulo', text: 'texto', button: 'BOTAO' }
);

const { app } = require('../server');
const { initDb, getDb, closeDb } = require('../db/database');
const { createOrder, updateOrderPayment } = require('../services/orders');
const { confirmPayment } = require('../services/entitlements');
const mockProvider = require('../payments/mock-provider');

let server;
let base;
let pass = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) throw new Error('FALHOU: ' + name);
  pass += 1;
};

async function request(route, token) {
  const response = await fetch(base + route, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  return { status: response.status, body, text };
}

/** Cria um pedido do plano mensal já com PIX gerado (mock). */
async function novoPedido() {
  const token = crypto.randomBytes(32).toString('hex');
  const order = await createOrder(require('../products').ayla_monthly, token, 'mock');
  await updateOrderPayment(order.public_id, await mockProvider.createPixPayment({ orderId: order.public_id }));
  return { token, publicId: order.public_id, id: order.id };
}

async function main() {
  await initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  /* -------------------------------------------------------- 1. PENDING */
  const pendente = await novoPedido();
  check('pedido PENDING não acessa o VIP', (await request(`/api/vip/${pendente.publicId}`, pendente.token)).status === 403);

  /* --------------------------------------------- 2. PAID sem entitlement */
  const semGrant = await novoPedido();
  await (await getDb()).run("UPDATE orders SET status='PAID', paid_at=CURRENT_TIMESTAMP WHERE id=?", semGrant.id);
  const semGrantResponse = await request(`/api/vip/${semGrant.publicId}`, semGrant.token);
  check('pedido PAID sem entitlement não acessa', semGrantResponse.status === 403);

  /* -------------------------------------------------- 3. entitlement ativo */
  const ativo = await novoPedido();
  await confirmPayment(ativo.publicId);
  const liberado = await request(`/api/vip/${ativo.publicId}`, ativo.token);
  check('entitlement ACTIVE acessa', liberado.status === 200 && liberado.body.granted === true);
  check('feed vem montado', Array.isArray(liberado.body.feed) && liberado.body.feed.length === 2,
    `${liberado.body.feed && liberado.body.feed.length} itens`);
  check('post sem arquivo fica fora do feed', !liberado.body.feed.some((post) => post.id === 2));
  check('bloco de CTA vem sem mídia', liberado.body.feed.some((post) => post.type === 'cta' && !post.media));

  /* ------------------------------------------------------- 4. token errado */
  const outroToken = crypto.randomBytes(32).toString('hex');
  check('token inválido não acessa', (await request(`/api/vip/${ativo.publicId}`, outroToken)).status === 403);
  check('sem token não acessa', (await request(`/api/vip/${ativo.publicId}`)).status === 403);

  /* ------------------------------------------------------------ 5. mídia */
  const mediaPath = liberado.body.feed.find((post) => post.type === 'image').media;
  const midia = await request(mediaPath);
  check('link assinado entrega a mídia', midia.status === 200 && midia.text === 'CONTEUDO-PAGO-SECRETO');

  check('link assinado adulterado é recusado', (await request(mediaPath.slice(0, -3) + 'xyz')).status === 403);

  const outroPedidoMedia = await request(`/api/vip/media/${'a'.repeat(40)}.${'b'.repeat(40)}`);
  check('link forjado é recusado', outroPedidoMedia.status === 403);

  /* ----------------------------------- 6. nada estático para o conteúdo */
  for (const rota of [
    `/${FOLDER}/segredo.jpg`,
    `/Area_membro/0d43266a68de4f6398771f421cdc2ab6.jpeg`,
    `/Midias_Bloqueadas/565802ff-60bd-482f-bb3f-7a7ca2a48dbc.mp4`,
    `/backend/vip-content.js`,
    `/vip.js/../${FOLDER}/segredo.jpg`
  ]) {
    const resposta = await request(rota);
    check(`conteúdo privado não sai por URL estática: ${rota}`, resposta.status === 404, `status ${resposta.status}`);
  }

  check('a página /vip é servida (o conteúdo é que é protegido)', (await request('/vip')).status === 200);

  /* ------------------------------------------------- 7. sem dado pessoal */
  await (await getDb()).run(
    `UPDATE orders SET customer_name='Maria Souza', customer_email='maria@example.com',
       customer_phone='31999998888', customer_document_hash='abc', customer_document_last3='725' WHERE id=?`,
    ativo.id
  );
  const corpo = JSON.stringify((await request(`/api/vip/${ativo.publicId}`, ativo.token)).body).toLowerCase();
  for (const vazamento of ['maria', 'example.com', '31999998888', 'customer', 'document',
    'checkout_hash', 'webhook_token', 'pix_', 'provider_payment']) {
    check(`endpoint VIP não vaza "${vazamento}"`, !corpo.includes(vazamento));
  }

  /* --------------------------------------------------------- 8. expirado */
  await (await getDb()).run(
    "UPDATE entitlements SET expires_at=datetime('now','-1 minute') WHERE order_id=?", ativo.id
  );
  const expirado = await request(`/api/vip/${ativo.publicId}`, ativo.token);
  check('entitlement EXPIRED não acessa', expirado.status === 403);
  check('e a resposta diz que expirou (para a tela de renovar)', expirado.body.expired === true);
  check('mídia também para de sair depois de expirar', (await request(mediaPath)).status === 403);

  /* ------------------------------------------- 9. whatsapp segue desligado */
  check('ayla_whatsapp_unlock continua desativado', require('../products').ayla_whatsapp_unlock.enabled === false);

  console.log(`\nPASS: área VIP — ${pass} verificações`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closeDb();
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  });
