/**
 * O MESMO FLUXO, CONTRA POSTGRES DE VERDADE.
 *
 * Os testes de tests/run.js exercitam o caminho SQLite (inclusive coisas que só
 * existem lá, como o gatilho de rollback e a migração do banco legado). Este
 * arquivo prova que services, webhook, entitlements e autorização funcionam
 * igual quando a persistência é PostgreSQL — que é o que vai para produção.
 *
 * Só roda quando TEST_DATABASE_URL estiver definida:
 *   TEST_DATABASE_URL=postgresql://... npm run test:pg
 *
 * Nenhuma cobrança real: PAYMENT_PROVIDER=mock.
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
require('dotenv').config();

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP: tests/postgres.js (defina TEST_DATABASE_URL para rodar)');
  process.exit(0);
}

process.env.DATABASE_URL = url;
process.env.PAYMENT_PROVIDER = 'mock';
process.env.NODE_ENV = 'test';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.TELEGRAM_BOT_USERNAME = 'TestAylaBot';
process.env.FRONTEND_URL = 'http://localhost:5500';
// O teste começa sem destino e só habilita a compra dentro do schema isolado.
process.env.WHATSAPP_NUMBER = '';

// Every test query is confined to a fresh schema, including transaction-pooler connections.
const pg = require('pg');
const RealPool = pg.Pool;
const testSchema = 'test_' + crypto.randomBytes(12).toString('hex');
process.env.TEST_DATABASE_SCHEMA = testSchema;
const control = new RealPool({ connectionString: url });
class IsolatedPool extends RealPool {
  async connect() {
    const client = await super.connect();
    const query = client.query.bind(client);
    return { release: () => client.release(), query: async (sql, values) => {
      const result = await query(sql, values);
      if (/^BEGIN\b/i.test(String(sql))) {
        await query(`SET LOCAL search_path TO ${testSchema}`);
        assert.equal((await query('SELECT current_schema() AS name')).rows[0].name, testSchema, 'ABORT: public or unisolated schema');
      }
      return result;
    } };
  }
  async query(sql, values) {
    const client = await this.connect();
    try { await client.query('BEGIN'); const result = await client.query(sql, values); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
Object.defineProperty(pg, 'Pool', { value: IsolatedPool });

const { app } = require('../server');
const { getDb, initDb, closeDb, driver } = require('../db/database');
const { hash } = require('../services/security');
const { confirmPayment } = require('../services/entitlements');
const { generateAccessToken, validateAndConsumeToken } = require('../services/access-tokens');

const token = crypto.randomBytes(32).toString('hex');
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
let server;
let base;

async function request(route, body, customHeaders = headers) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function main() {
  assert.equal(driver, 'postgres', 'DATABASE_URL deveria ter selecionado o Postgres');

  // Banco limpo: este arquivo é destrutivo por natureza, então nunca aponte
  // TEST_DATABASE_URL para um banco com dados reais.
  await control.query(`CREATE SCHEMA ${testSchema}`);
  const db = await initDb();
  await initDb();

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  /* ---------------------------------------------------- criação do pedido */
  const body = { productId: 'ayla_quarterly', checkoutToken: token, client: {phone:'11999990000'}, price: 0.01, amount: 1 };
  const [first, second] = await Promise.all([
    request('/api/payments/pix', body),
    request('/api/payments/pix', body)
  ]);
  assert.ok([200, 201, 202].includes(first.status), 'primeira criação');
  assert.ok([200, 201, 202].includes(second.status), 'segunda criação (duplo clique)');

  const order = await (await getDb()).get('SELECT * FROM orders WHERE checkout_hash=?', hash(token));
  assert.equal((await (await getDb()).get('SELECT COUNT(*) n FROM orders WHERE checkout_hash=?', hash(token))).n, 1,
    'duplo clique não pode criar dois pedidos');
  assert.equal(order.amount, 19.9, 'preço vem do catálogo do backend, não do corpo da requisição');
  assert.equal(order.status, 'PENDING');

  // Formato das datas: string 'YYYY-MM-DD HH:MM:SS', igual ao SQLite. O
  // server.js faz expires_at.replace(' ', 'T') — com Date isso quebraria.
  assert.equal(typeof order.created_at, 'string');
  assert.match(order.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  /* ------------------------------------------------------- autorização */
  assert.equal((await request('/api/orders/' + order.public_id + '/status')).body.status, 'PENDING');
  assert.equal((await request('/api/orders/' + order.public_id + '/status', undefined, {})).status, 403,
    'status sem o token do checkout deve ser negado');
  assert.equal((await request('/api/vip/' + order.public_id)).status, 403, 'VIP antes de pagar');
  assert.equal((await request('/api/access/' + order.public_id)).status, 403);

  /* ---------------------------------------------------------- webhook */
  assert.equal((await request('/api/payments/webhook', { token: 'fake', event: 'TRANSACTION_PAID' })).status, 401);

  const webhookToken = crypto.randomBytes(32).toString('hex');
  await (await getDb()).run('UPDATE orders SET webhook_token_hash=? WHERE id=?', hash(webhookToken), order.id);

  assert.equal(
    (await request('/api/payments/webhook', { token: webhookToken, event: 'TRANSACTION_PAID', transactionId: 'wrong' })).status,
    401, 'transactionId divergente'
  );
  assert.equal((await request('/api/payments/webhook', { token: webhookToken, event: 'OTHER' })).body.ignored, true);
  assert.equal((await (await getDb()).get('SELECT status FROM orders WHERE id=?', order.id)).status, 'PENDING');

  const event = { token: webhookToken, event: 'TRANSACTION_PAID', transactionId: order.provider_payment_id };
  const approvals = await Promise.all(Array.from({ length: 8 }, () => request('/api/payments/webhook', event)));
  assert.ok(approvals.every((r) => r.status === 200), '8 webhooks simultâneos');

  const paid = await (await getDb()).get('SELECT * FROM orders WHERE id=?', order.id);
  const grant = await (await getDb()).get('SELECT * FROM entitlements WHERE order_id=?', order.id);
  assert.equal(paid.status, 'PAID');
  assert.equal((await (await getDb()).get('SELECT COUNT(*) n FROM entitlements WHERE order_id=?', order.id)).n, 1,
    'um entitlement por pedido, mesmo com webhooks concorrentes');

  await request('/api/payments/webhook', event);
  assert.equal((await (await getDb()).get('SELECT paid_at FROM orders WHERE id=?', order.id)).paid_at, paid.paid_at,
    'webhook repetido não mexe em paid_at');
  assert.equal((await (await getDb()).get('SELECT expires_at FROM entitlements WHERE id=?', grant.id)).expires_at,
    grant.expires_at, 'webhook repetido não estende o acesso');

  // 90 dias do plano trimestral.
  const days = (Date.parse(grant.expires_at.replace(' ', 'T') + 'Z') - Date.parse(grant.starts_at.replace(' ', 'T') + 'Z'))
    / 86400000;
  assert.equal(Math.round(days), 90, 'validade do plano trimestral');

  /* -------------------------------------------------------------- VIP */
  assert.equal((await request('/api/vip/' + order.public_id)).body.granted, true);

  const raw = await generateAccessToken(order.id);
  assert.match(raw, /^[a-f0-9]{64}$/);
  assert.equal((await validateAndConsumeToken(raw, '12345')).valid, true);
  assert.equal((await validateAndConsumeToken(raw, '99999')).valid, false, 'token de acesso não serve para outra conta');

  /* --------------------------------------------------------- expiração */
  await (await getDb()).run("UPDATE entitlements SET expires_at=datetime('now','-1 minute') WHERE id=?", grant.id);
  assert.equal((await request('/api/vip/' + order.public_id)).status, 403, 'acesso expirado');

  /* --------------------------------------- produto avulso (whatsapp) */
  const products = require('../products');
  assert.equal(products.ayla_whatsapp_unlock.enabled, false, 'ayla_whatsapp_unlock continua desativado');
  assert.equal((await request('/api/payments/pix', { productId: 'ayla_whatsapp_unlock', checkoutToken: token })).status, 409);
  process.env.WHATSAPP_NUMBER = '5548999990000';
  assert.equal(products.ayla_whatsapp_unlock.enabled, true, 'um destino válido habilita a compra');
  assert.equal((await request('/api/payments/pix', {
    productId: 'ayla_whatsapp_unlock', checkoutToken: crypto.randomBytes(32).toString('hex'), client: { phone: '11999990000' }
  })).status, 201);

  const { createOrder, updateOrderPayment } = require('../services/orders');
  const oneTime = await createOrder(products.ayla_whatsapp_unlock, crypto.randomBytes(32).toString('hex'), 'mock');
  await updateOrderPayment(oneTime.public_id,
    await require('../payments/mock-provider').createPixPayment({ orderId: oneTime.public_id }));
  assert.equal((await confirmPayment(oneTime.public_id)).expires_at, null, 'acesso vitalício não tem expiração');

  /* ------------------------------------------------- rollback atômico */
  // Se a criação do entitlement falhar, o pedido NÃO pode ficar pago.
  const rollbackToken = crypto.randomBytes(32).toString('hex');
  const rollbackOrder = await createOrder(products.ayla_monthly, rollbackToken, 'mock');
  await updateOrderPayment(rollbackOrder.public_id,
    await require('../payments/mock-provider').createPixPayment({ orderId: rollbackOrder.public_id }));
  await (await getDb()).exec(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'test rollback'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_fail_trigger BEFORE INSERT ON entitlements
      FOR EACH ROW EXECUTE FUNCTION test_fail();`);
  await assert.rejects(confirmPayment(rollbackOrder.public_id));
  assert.equal((await (await getDb()).get('SELECT status FROM orders WHERE public_id=?', rollbackOrder.public_id)).status,
    'PENDING', 'falha ao liberar acesso desfaz a aprovação do pagamento');
  await (await getDb()).exec('DROP TRIGGER test_fail_trigger ON entitlements; DROP FUNCTION test_fail();');

  /* --------------------------------- dados do cliente: guardar o certo */
  const clientToken = crypto.randomBytes(32).toString('hex');
  const withClient = await createOrder(products.ayla_monthly, clientToken, 'mock', {
    name: '  Maria Souza  ', email: 'MARIA@Example.com ', phone: '(31) 99999-8888', document: '529.982.247-25'
  });
  const stored = await (await getDb()).get('SELECT * FROM orders WHERE id=?', withClient.id);
  assert.equal(stored.customer_name, 'Maria Souza');
  assert.equal(stored.customer_email, 'maria@example.com');
  assert.equal(stored.customer_phone, '5531999998888', 'celular normalizado com código do país');
  assert.equal(stored.customer_document_last3, '725');
  assert.equal(stored.customer_document_hash, hash('52998224725'));
  // O CPF inteiro não pode estar em lugar nenhum da linha.
  assert.ok(!JSON.stringify(stored).includes('52998224725'), 'CPF não é guardado em texto puro');
  assert.ok(!JSON.stringify(stored).includes('529.982.247-25'));

  /* --------------------------------------- nada sensível no endpoint */
  const status = (await request('/api/orders/' + order.public_id + '/status')).body;
  for (const leak of ['webhook_token_hash', 'checkout_hash', 'pix_qr_code', 'customer', 'document', 'cpf']) {
    assert.ok(!JSON.stringify(status).toLowerCase().includes(leak), `status não pode expor ${leak}`);
  }

  process.env.VIP_MEDIA_DRIVER='supabase';
  await require('./crop-delete')(await getDb());
  const likeDb = await getDb();
  const likePosts = require('../services/vip-posts');
  await likeDb.run("INSERT INTO vip_posts(id,type,media_path,media_driver,published,likes_count) VALUES ('likes-regression','image','ayla/qa.jpg','supabase',1,318)");
  await likePosts.setSource('managed');
  const likeFeed = async () => (await likePosts.feed(order.id)).find(p => p.id === 'likes-regression');
  assert.equal((await likeFeed()).liked, false, 'COUNT string zero must be false');
  for (const liked of [true, true, false, false]) {
    assert.equal((await likePosts.like('likes-regression', order.id, liked)).likes, 318 + Number(liked));
    assert.equal((await likeFeed()).liked, liked);
    assert.equal((await likeFeed()).likes, 318 + Number(liked));
  }
  console.log('PASS real PostgreSQL likes: count, duplicate like/unlike, persisted state, COUNT string zero');
  process.env.VIP_MEDIA_SECRET = crypto.randomBytes(32).toString('hex');
  await require('./buyer-recovery')(await getDb());
  await require('./grant-scope')();
  console.log('PASS: Postgres — criação, duplo clique, webhook (token, divergência, idempotência),'
    + ' entitlement único, rollback atômico, VIP, expiração, formato de datas,'
    + ' cliente sem CPF em texto puro, status sem dados sensíveis');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closeDb();
    await control.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
    await control.end();
  });
