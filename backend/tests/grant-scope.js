const assert = require('node:assert/strict');
const crypto = require('node:crypto');
async function contract() {
  const database = require('../db/database'), db = await database.getDb();
  const orders = require('../services/orders'), grants = require('../services/entitlements');
  const products = require('../products');
  async function create(product) {
    const order = await orders.createOrder(product, crypto.randomBytes(32).toString('hex'), 'mock');
    await orders.updateOrderPayment(order.public_id, { providerPaymentId: crypto.randomUUID(), webhookToken: crypto.randomUUID(), pix: { copyPaste: 'isolated-test', qrCode: null } });
    return orders.getOrderByPublicId(order.public_id);
  }
  const sub = await create(products.ayla_monthly);
  const product = { id: 'ayla_isolated-ppv-' + crypto.randomUUID(), price: 1, type: 'ppv', resourceType: 'post', resourceId: '123' };
  const ppv = await create(product);
  assert.equal(await grants.activeSubscription(sub), null);
  assert.equal(await grants.hasResourceAccess(ppv, 'post', '123'), false);
  await grants.confirmPayment(sub.public_id);
  const paidSub = await orders.getOrderByPublicId(sub.public_id);
  const original = await grants.activeSubscription(paidSub);
  assert.ok(original);
  assert.equal(await grants.hasResourceAccess(paidSub, 'post', '123'), false);
  for (let n = 0; n < 5; n++) await grants.confirmPayment(ppv.public_id);
  const paid = await orders.getOrderByPublicId(ppv.public_id);
  assert.equal(await grants.activeSubscription(paid), null);
  assert.equal(await grants.hasResourceAccess(paid, 'post', '123'), true);
  assert.equal(await grants.hasResourceAccess(paid, 'post', '124'), false);
  assert.equal(await grants.hasResourceAccess(paid, 'video', '123'), false);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM entitlements WHERE order_id=?', paid.id)).n), 1);
  assert.equal((await db.get('SELECT expires_at FROM entitlements WHERE order_id=?', paid.id)).expires_at, null);
  assert.deepEqual(await grants.activeSubscription(paidSub), original, 'PPV cannot renew subscription');
  for (const status of ['PENDING','FAILED','EXPIRED']) assert.equal(await grants.hasResourceAccess({...paid,status}, 'post', '123'), false);
  await db.run("UPDATE entitlements SET status='EXPIRED' WHERE order_id=?", paid.id);
  assert.equal(await grants.hasResourceAccess(paid, 'post', '123'), false);
  await assert.rejects(create({...product,resourceId:null}));
  await assert.rejects(create({...product,accessDays:30}));
  await database.initDb(); // Restart/migration remains additive, including legacy archive.
  assert.deepEqual(await grants.activeSubscription(paidSub), original);
  assert.equal(products.ayla_whatsapp_unlock.enabled,
    /^\d{10,15}$/.test((process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '')));
  console.log('PASS grant scope: additive restart, PPV resource only, subscription isolated, five approvals idempotent, expiry and invalid metadata denied');
}
module.exports = contract;
if (require.main === module) {
  require('./sqlite-env');
  process.env.DATABASE_PATH = require('path').resolve(__dirname, '../.test-runs/grants-' + crypto.randomUUID() + '.sqlite');
  const database = require('../db/database');
  database.initDb().then(contract).catch(e => { console.error(e); process.exitCode=1; }).finally(()=>database.closeDb());
}
