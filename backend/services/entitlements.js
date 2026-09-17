const { getDb, transaction } = require('../db/database');
const products = require('../products');

async function insertEntitlement(db, order) {
  require('../creator').assertProduct(order.product_id);
  if (order.status !== 'PAID') throw new Error('Order must be paid');
  // Voluntary tips are receipts, never an access grant.
  if (order.purchase_kind === 'tip') return null;
  const type = order.grant_type;
  if (!['subscription','ppv','contact'].includes(type)) throw new Error('Invalid grant type');
  if (type === 'ppv' && (!order.resource_type || !order.resource_id || order.access_type !== 'ppv')) throw new Error('Invalid PPV scope');
  const days = type === 'subscription' ? order.access_days || products[order.product_id]?.accessDays || null : null;
  await db.run(`INSERT INTO entitlements (order_id, product_id, starts_at, expires_at, status, grant_type, resource_type, resource_id)
    VALUES (?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime(?, ?) END, 'ACTIVE', ?, ?, ?)
    ON CONFLICT(order_id) DO NOTHING`,
    // Acesso vitalício (produto avulso) não tem intervalo: mandamos NULL em vez
    // de montar "+null days". O SQLite nem avaliava esse ramo do CASE; o
    // Postgres converte o parâmetro antes e recusaria a cobrança.
    order.id, order.product_id, order.paid_at, days, order.paid_at, days ? '+' + days + ' days' : null,
    type, type === 'ppv' ? order.resource_type : null, type === 'ppv' ? order.resource_id : null);
  return db.get('SELECT * FROM entitlements WHERE order_id=?', order.id);
}
async function createOrUpdateEntitlement(orderId, productId) {
  return transaction(async db => {
    const order = await db.get('SELECT * FROM orders WHERE id=?', orderId);
    if (!order || order.product_id !== productId) throw new Error('Order mismatch');
    return insertEntitlement(db, order);
  });
}
async function confirmPayment(publicId, expected = null) {
  const result = await transaction(async db => {
    let order = await db.get('SELECT * FROM orders WHERE public_id=?', publicId);
    if (!order || !order.provider_payment_id) throw new Error('Payment not persisted');
    require('../creator').assertProduct(order.product_id);
    if (expected && (order.payment_provider !== expected.provider || order.provider_payment_id !== expected.identifier || Math.round(Number(order.amount)*100) !== expected.cents)) throw Object.assign(new Error('Payment mismatch'), { status:409 });
    if (!['PENDING','EXPIRED','PAID'].includes(order.status)) throw new Error('Invalid transition');
    await db.run("UPDATE orders SET status='PAID', paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE id=?", order.id);
    order = await db.get('SELECT * FROM orders WHERE id=?', order.id);
    if(order.claim_required && !order.buyer_id) {
      if(!order.purchase_buyer_id) return null;
      const buyer=await db.get("SELECT user_id FROM buyer_accounts WHERE user_id=? AND role='BUYER'",order.purchase_buyer_id);
      if(!buyer) return null;
      await db.run('UPDATE orders SET buyer_id=?,claimed_at=CURRENT_TIMESTAMP,claim_token_hash=NULL WHERE id=? AND buyer_id IS NULL',buyer.user_id,order.id);
      order=await db.get('SELECT * FROM orders WHERE id=?',order.id);
    }
    return insertEntitlement(db, order);
  });
  const settled = await (await getDb()).get('SELECT product_id,purchase_kind FROM orders WHERE public_id=? AND status=\'PAID\'', publicId);
  if (settled) { const paidOrder=await (await getDb()).get('SELECT * FROM orders WHERE public_id=?',publicId);await require('./push').notifyPaid(paidOrder).catch(()=>{}); const analytics=require('./analytics'); await analytics.write('payment_confirmed',null,settled.product_id,publicId).catch(()=>{}); if(settled.purchase_kind==='tip')await analytics.write('tip_paid',null,settled.product_id,publicId).catch(()=>{}); }
  return result;
}

async function getActiveEntitlementByTelegramUserId(telegramUserId) {
    const db = await getDb();
    return db.get(`
        SELECT * FROM entitlements 
        WHERE telegram_user_id = ? 
        AND status = 'ACTIVE' 
        AND grant_type = 'subscription'
        AND expires_at > CURRENT_TIMESTAMP
        ORDER BY expires_at DESC LIMIT 1
    `, [telegramUserId]);
}

async function linkEntitlementToTelegram(entitlementId, telegramUserId) {
  const db = await getDb();
  await db.run(
    `UPDATE entitlements SET telegram_user_id = ? WHERE id = ?`,
    [telegramUserId, entitlementId]
  );
}

async function getExpiredEntitlements() {
  const db = await getDb();
  return db.all(`SELECT * FROM entitlements WHERE status = 'ACTIVE' AND expires_at <= CURRENT_TIMESTAMP`);
}

async function expireEntitlement(id) {
  const db = await getDb();
  await db.run(`UPDATE entitlements SET status = 'EXPIRED' WHERE id = ?`, [id]);
}

module.exports = {
  insertEntitlement,
  activeSubscription,
  hasResourceAccess,
  createOrUpdateEntitlement,
  confirmPayment,
  getActiveEntitlementByTelegramUserId,
  linkEntitlementToTelegram,
  getExpiredEntitlements,
  expireEntitlement
};

async function activeSubscription(order) {
  if (!order || !require('../creator').ownsProduct(order.product_id) || order.status !== 'PAID' || order.access_type !== 'vip' || order.grant_type !== 'subscription') return null;
  return (await getDb()).get("SELECT * FROM entitlements WHERE order_id=? AND grant_type='subscription' AND resource_type IS NULL AND resource_id IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)", order.id);
}

// Internal authorization primitive for future resource endpoints, after ownership.
async function hasResourceAccess(order, resourceType, resourceId) {
  if (!order || !require('../creator').ownsProduct(order.product_id) || order.status !== 'PAID' || order.access_type !== 'ppv' || order.grant_type !== 'ppv' || order.resource_type !== resourceType || order.resource_id !== String(resourceId)) return false;
  return Boolean(await (await getDb()).get("SELECT id FROM entitlements WHERE order_id=? AND grant_type='ppv' AND resource_type=? AND resource_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)", order.id, resourceType, String(resourceId)));
}
