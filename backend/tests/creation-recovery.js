require('./sqlite-env');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
Object.assign(process.env, { BUYER_ACCOUNT_FLOW: 'true', PAYMENT_PROVIDER: 'mock', DATABASE_PATH: path.resolve(__dirname, '../.test-runs/creation-' + crypto.randomUUID() + '.sqlite') });
const database = require('../db/database'), orders = require('../services/orders'), products = require('../products');
const provider = require('../payments/provider'), { app } = require('../server');
let server, calls = 0, failure = null;
const original = provider.createPixPayment;
provider.createPixPayment = async input => {
  calls++;
  if (failure) { const error = failure; failure = null; throw error; }
  await new Promise(resolve => setTimeout(resolve, 50));
  return original(input);
};
(async () => {
  await database.initDb(); await database.initDb();
  const db = await database.getDb();
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async token => {
    const response = await fetch(base + '/api/payments/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 'ayla_monthly', checkoutToken: token }) });
    return { status: response.status, data: await response.json() };
  };
  const make = async () => {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, order: await orders.createOrder(products.ayla_monthly, token, 'mock') };
  };
  // Crash after insertion, before contacting provider. Exactly one caller resumes.
  const ready = await make();
  const results = await Promise.all([request(ready.token), request(ready.token)]);
  assert.equal(calls, 1); assert(results.some(result => result.status === 201));
  assert(results.every(result => [200, 201, 202].includes(result.status)));
  const recovered = await request(ready.token);
  assert.equal(recovered.data.orderId, ready.order.public_id); assert.equal(calls, 1);
  // Crash after dispatch: recent stays waiting, stale becomes visible review state.
  const uncertain = await make(); await orders.beginPaymentCreation(uncertain.order.public_id);
  assert.equal((await request(uncertain.token)).status, 202);
  await db.run('UPDATE orders SET creation_started_at=? WHERE public_id=?', Date.now() - orders.CREATION_TIMEOUT_MS - 1000, uncertain.order.public_id);
  const stopped = await request(uncertain.token);
  assert.equal(stopped.status, 409); assert.equal(stopped.data.requiresReview, true);
  assert.equal(calls, 1);
  const report = await require('../services/conversions').summary();
  assert(report.reviewOrders.some(order => order.public_id === uncertain.order.public_id));
  // A late successful result can still attach to its original uncertain order.
  await orders.updateOrderPayment(uncertain.order.public_id, await original({ orderId: uncertain.order.public_id }));
  assert.equal((await orders.getOrderByPublicId(uncertain.order.public_id)).status, 'PENDING'); assert.equal(calls, 1);
  // Safe pre-dispatch failure retries same order, no second order or claim.
  const safe = await make(); failure = Object.assign(new Error('Auth unavailable'), { paymentCreationSafeToRetry: true });
  assert.equal((await request(safe.token)).data.retryable, true);
  assert.equal((await request(safe.token)).data.orderId, safe.order.public_id);
  // Unknown gateway result does not authorize a replay.
  const network = await make(); failure = new Error('Ambiguous network failure');
  assert.equal((await request(network.token)).data.requiresReview, true);
  const before = calls; assert.equal((await request(network.token)).status, 409); assert.equal(calls, before);
  // Legacy rows have no proof of pre-dispatch state, so remain conservative.
  const legacy = await make();
  await db.run("UPDATE orders SET creation_phase='legacy',creation_started_at=NULL,created_at=datetime('now','-5 minutes') WHERE public_id=?", legacy.order.public_id);
  assert.equal((await orders.recoverCreation(await orders.getOrderByPublicId(legacy.order.public_id))).creation_phase, 'uncertain'); assert.equal(calls, before);
  assert.equal((await db.get('SELECT COUNT(*) n FROM orders')).n, 5);
  assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements')).n, 0);
  console.log('PASS creation recovery: crash before/after dispatch, concurrent retry, safe auth failure, ambiguous no replay, late persistence, legacy rows, admin review, no grants');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  provider.createPixPayment = original;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await database.closeDb();
});
