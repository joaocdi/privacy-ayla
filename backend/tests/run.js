require('./sqlite-env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, crypto.randomUUID() + '.sqlite');
// Never inherit the real DATABASE_URL from backend/.env in the SQLite suite.
process.env.DATABASE_URL = '';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.NODE_ENV = 'test';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.TELEGRAM_BOT_USERNAME = 'TestAylaBot';
process.env.FRONTEND_URL = 'http://localhost:5500';
const { app } = require('../server');
const { initDb, getDb, closeDb } = require('../db/database');
const { hash } = require('../services/security');
const { confirmPayment } = require('../services/entitlements');
let server;
let base;
const token = crypto.randomBytes(32).toString('hex');
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
async function request(route, body, customHeaders = headers) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: customHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function child(file, env) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [file], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ...env }, stdio: 'inherit' });
    cp.on('error', reject); cp.on('exit', code => code === 0 ? resolve() : reject(new Error(file + ' exited ' + code)));
  });
}
async function main() {
  await initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  await child('test-suite.js', { TEST_BASE_URL: base });
  const db = await getDb();
  // Concurrent retries must produce one order and one provider call.
  const body = { productId: 'ayla_quarterly', checkoutToken: token, client: {phone:'11999990000'}, price: 0.01, amount: 1 };
  const results = await Promise.all([request('/api/payments/pix', body), request('/api/payments/pix', body)]);
  assert.ok(results.every(r => [200,201,202].includes(r.status)));
  const order = await db.get('SELECT * FROM orders WHERE checkout_hash=?', hash(token));
  assert.equal(order.amount, 19.9);
  assert.equal((await db.get('SELECT COUNT(*) n FROM orders WHERE checkout_hash=?', hash(token))).n, 1);
  assert.equal((await request('/api/orders/' + order.public_id + '/status')).body.status, 'PENDING');
  assert.equal((await request('/api/vip/' + order.public_id)).status, 403);
  assert.equal((await request('/api/access/' + order.public_id)).status, 403);
  assert.equal((await request('/api/orders/' + order.public_id + '/status', undefined, {})).status, 403);
  assert.equal((await request('/api/payments/webhook', { token: 'fake', event: 'TRANSACTION_PAID' })).status, 401);
  assert.equal((await request('/api/payments/webhook', { orderId: order.public_id, status: 'PAID' })).status, 401);
  const webhookToken = crypto.randomBytes(32).toString('hex');
  await db.run('UPDATE orders SET webhook_token_hash=? WHERE id=?', hash(webhookToken), order.id);
  assert.equal((await request('/api/payments/webhook', { token: webhookToken, event: 'TRANSACTION_PAID', transactionId: 'wrong' })).status, 401);
  assert.equal((await request('/api/payments/webhook', { token: webhookToken, event: 'OTHER' })).body.ignored, true);
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', order.id)).status, 'PENDING');
  // Failure between approval and grant must roll back the payment.
  await db.exec("CREATE TRIGGER test_fail BEFORE INSERT ON entitlements BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  await assert.rejects(confirmPayment(order.public_id));
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', order.id)).status, 'PENDING');
  await db.exec('DROP TRIGGER test_fail;');
  const event = { token: webhookToken, event: 'TRANSACTION_PAID', transactionId: order.provider_payment_id };
  const approvals = await Promise.all(Array.from({ length: 8 }, () => request('/api/payments/webhook', event)));
  assert.ok(approvals.every(r => r.status === 200));
  const grant = await db.get('SELECT * FROM entitlements WHERE order_id=?', order.id);
  const paid = await db.get('SELECT * FROM orders WHERE id=?', order.id);
  assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements WHERE order_id=?', order.id)).n, 1);
  await request('/api/payments/webhook', event);
  assert.equal((await db.get('SELECT paid_at FROM orders WHERE id=?', order.id)).paid_at, paid.paid_at);
  assert.equal((await db.get('SELECT expires_at FROM entitlements WHERE id=?', grant.id)).expires_at, grant.expires_at);
  assert.equal((await request('/api/vip/' + order.public_id)).body.granted, true);
  await db.run("UPDATE entitlements SET expires_at=datetime('now','-1 minute') WHERE id=?", grant.id);
  assert.equal((await request('/api/vip/' + order.public_id)).status, 403);
  assert.equal((await request('/api/access/' + order.public_id)).status, 403);
  for (const route of ['/backend/server.js','/backend/db/database.sqlite','/backend/.env','/Privacy_Sites.zip','/Area_membro/x.jpeg']) {
    assert.equal((await request(route)).status, 404, route);
  }
  // Perfil: uma fonte só para as duas telas.
  const publicProfile = (await request('/api/profile')).body;
  const vipProfile = require('../vip-content').profile;
  for (const field of ['name', 'username', 'bio']) {
    assert.equal(publicProfile[field], vipProfile[field], 'perfil público difere do /vip em ' + field);
  }
  // Os contadores agora vêm do conteúdo real somado à base histórica do perfil.
  const baseHistorica = Number(String(vipProfile.stats.likes).replace(/[^0-9]/g, '')) || 0;
  assert.deepEqual(publicProfile.stats, await require('../services/profile').stats(), 'números do perfil divergem entre as telas');
  assert.ok(publicProfile.stats.likes >= baseHistorica, 'a base histórica de curtidas do perfil é preservada');
  assert.ok(!JSON.stringify(publicProfile).includes('media_path') && publicProfile.avatar.startsWith('/api/profile/media/avatar?') && publicProfile.cover.startsWith('/api/profile/media/cover?'),
    'o perfil público fornece somente rotas fixas de imagens do perfil');
  const homeHtml = await fetch(base + '/index.html').then(r => r.text());
  assert.ok(homeHtml.includes('id="profileName"') && !homeHtml.includes(vipProfile.bio),
    'a HOME carrega o perfil compartilhado sem duplicar a bio');
  assert.ok(!/VÍDEO EXCLUSIVO|MEU DIÁRIO/.test(homeHtml + await fetch(base + '/app.js').then(r => r.text())),
    'a faixa de vídeo exclusivo saiu do feed');
  assert.ok(!/vip-post-type/.test(await fetch(base + '/vip.js').then(r => r.text())),
    'a etiqueta FOTO/VÍDEO saiu do feed do assinante');

  // Contato do WhatsApp: montado no servidor, nunca escrito no frontend.
  assert.equal((await request('/api/contact')).body.whatsapp, null, 'sem número configurado não existe link');
  process.env.WHATSAPP_NUMBER = '+55 (48) 99999-0000';
  assert.equal((await request('/api/contact')).body.whatsapp, null, 'contato pago não é público');
  process.env.WHATSAPP_MESSAGE = 'Oi Ayla!';
  assert.equal((await request('/api/contact')).body.whatsapp, null, 'mensagem não expõe destino');
  for (const invalid of ['123', 'javascript:alert(1)', 'abcdefghij', '1'.repeat(16)]) {
    process.env.WHATSAPP_NUMBER = invalid;
    assert.equal((await request('/api/contact')).body.whatsapp, null, 'número inválido: ' + invalid);
  }
  delete process.env.WHATSAPP_NUMBER; delete process.env.WHATSAPP_MESSAGE;
  const ordersBeforeContact = (await db.get('SELECT COUNT(*) n FROM orders')).n;
  await request('/api/contact');
  assert.equal((await db.get('SELECT COUNT(*) n FROM orders')).n, ordersBeforeContact, 'consultar o contato não cria pedido');
  const homePage = await fetch(base + '/index.html').then(r => r.text());
  const homeScript = await fetch(base + '/app.js').then(r => r.text());
  assert.ok(!/wa\.me|whatsapp\.com|\+?55\d{10}/i.test(homePage + homeScript), 'nenhum número ou link do WhatsApp no frontend');
  assert.equal((await request('/api/health', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/payments/pix', { productId:'ayla_whatsapp_unlock', checkoutToken:token })).status, 409);
  assert.equal(require('../products').ayla_whatsapp_unlock.price, 7.9);
  assert.equal(require('../products').ayla_whatsapp_unlock.type, 'one_time');
  const { createOrder, updateOrderPayment } = require('../services/orders');
  const oneTime = await createOrder(require('../products').ayla_whatsapp_unlock, crypto.randomBytes(32).toString('hex'), 'mock');
  await updateOrderPayment(oneTime.public_id, await require('../payments/mock-provider').createPixPayment({orderId:oneTime.public_id}));
  const oneTimeGrant = await confirmPayment(oneTime.public_id);
  assert.equal(oneTimeGrant.expires_at, null);
  const { spawnSync } = require('child_process');
  const production = spawnSync(process.execPath, ['-e', "const p=require('./payments/provider');if(p.name!=='unavailable'||Object.keys(require.cache).some(k=>/mock-provider/.test(k)))process.exit(3);p.createPixPayment({}).then(()=>process.exit(4),e=>process.exit(e.status===503?0:5))"], {cwd:path.resolve(__dirname,'..'),env:{...process.env,NODE_ENV:'production',PAYMENT_PROVIDER:'mock'}});
  assert.equal(production.status, 0, 'mock never loads in production; checkout answers 503');
  const restart = spawnSync(process.execPath, ['-e', "const {getDb,closeDb}=require('./db/database');getDb().then(async db=>{const r=await db.get('SELECT status FROM orders WHERE public_id=?',process.env.TEST_ORDER_ID);require('node:assert/strict').equal(r.status,'PAID');await closeDb()}).catch(()=>{process.exitCode=1})"], {cwd:path.resolve(__dirname,'..'),env:{...process.env,TEST_ORDER_ID:order.public_id}});
  assert.equal(restart.status, 0, 'payment must survive a fresh Node process');
  await closeDb();
  assert.equal((await (await getDb()).get('SELECT status FROM orders WHERE id=?', order.id)).status, 'PAID');
  console.log('PASS: concurrency, rollback, webhook validation/idempotency, authorization, expiry, price and persistence');
  await child('tests/provider.js');
  await child('tests/syncpay.js');
  await child('tests/tips.js');
  await child('tests/creation-recovery.js');
  await child('tests/buyer-accounts.js');
  await child('tests/sigilopay-diagnostic.js');
  await child('tests/isolation.js');
  await child('tests/ayla-isolation.js');
  await child('tests/ayla-postgres-schema.js');
  await child('tests/configurar-ayla.js');
  await child('tests/ayla-conteudo.js');
  await child('tests/ayla-production.js');
  await child('tests/ativar-syncpay-ayla.js');
  await child('tests/vercel-safety.js');
  await child('tests/preview-consolidation.js');
  await child('tests/migration.js');
  await child('tests/persistence.js');
  await child('tests/vip.js');
  await child('tests/vip-supabase.js');
  await child('tests/admin.js');
  await child('tests/likes.js');
  await child('tests/contact.js');
  await child('tests/buyer-recovery.js');
  await child('tests/grant-scope.js');
  await child('tests/admin-mode.js');
  await child('tests/crop-delete.js');
  await child('tests/preview-video.js');
  await child('tests/carousel.js');
  await child('tests/content-postgres.js');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDb();
  // Temporary fixture stays isolated from the existing database.
});
