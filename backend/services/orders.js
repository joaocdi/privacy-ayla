const crypto = require('crypto');
const { getDb, transaction } = require('../db/database');
const { hash } = require('./security');

/**
 * Guarda o contato do comprador, sem guardar o documento inteiro.
 *
 * Nome, e-mail e telefone ficam porque são como você fala com o cliente depois
 * da compra (o telefone é o mesmo que vai alimentar o WhatsApp e a automação).
 * O CPF/CNPJ vira hash + 3 últimos dígitos: dá para conferir um pagamento com a
 * SigiloPay e atender no suporte, sem manter uma base de CPF em texto puro.
 */
function customerColumns(client) {
  if (!client) return { name: null, email: null, phone: null, documentHash: null, documentLast3: null };
  const digits = String(client.document || '').replace(/\D/g, '');
  return {
    name: typeof client.name === 'string' ? client.name.trim().slice(0, 150) : null,
    email: typeof client.email === 'string' ? client.email.trim().toLowerCase().slice(0, 254) : null,
    phone: require('./buyer-phone')(client.phone) || (typeof client.phone === 'string' ? client.phone.replace(/\D/g, '').slice(0, 15) || null : null),
    documentHash: digits ? hash(digits) : null,
    documentLast3: digits ? digits.slice(-3) : null
  };
}

async function createOrder(product, checkoutToken, provider, client = null, buyerId = null) {
  require('../creator').assertProduct(product.id);
  // Catalog/server metadata only; no resource or grant scope comes from checkout.
  const grantType = product.type === 'ppv' ? 'ppv' : product.type === 'one_time' ? 'contact' : 'subscription';
  const resourceType = grantType === 'ppv' ? product.resourceType : null;
  const resourceId = grantType === 'ppv' && product.resourceId != null ? String(product.resourceId) : null;
  if (grantType === 'ppv' && (!['post', 'pack', 'video'].includes(resourceType) || !resourceId || resourceId.length > 200 || product.accessDays)) throw new Error('Invalid PPV resource');
  return transaction(async db => {
    const checkoutHash = hash(checkoutToken);
    const existing = await db.get('SELECT * FROM orders WHERE checkout_hash = ?', checkoutHash);
    if (existing) {
      if (existing.product_id !== product.id || (product.type === 'tip' && Math.round(existing.amount * 100) !== Math.round(product.price * 100))) throw Object.assign(new Error('Checkout já pertence a outro produto.'), { status: 409 });
      return { ...existing, fresh: false };
    }
    const id = 'ord_' + crypto.randomBytes(24).toString('hex');
    // ON CONFLICT: no SQLite o BEGIN IMMEDIATE serializa as escritas, mas o
    // Postgres deixa duas requisições concorrentes chegarem aqui juntas — sem
    // isto, o duplo clique virava violação de índice e um 502 na cara do
    // cliente. Quem perde a corrida apenas reaproveita o pedido do outro.
    const customer = customerColumns(client);
    const inserted = await db.run("INSERT INTO orders (public_id, product_id, amount, status, payment_provider, checkout_hash, access_days, access_type, customer_name, customer_email, customer_phone, customer_document_hash, customer_document_last3, expires_at, grant_type, resource_type, resource_id) VALUES (?, ?, ?, 'CREATING', ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ?='mock' THEN datetime('now', '+30 minutes') ELSE NULL END, ?, ?, ?) ON CONFLICT(checkout_hash) DO NOTHING",
      id, product.id, product.price, provider, checkoutHash, product.accessDays || null, grantType === 'ppv' ? 'ppv' : grantType === 'contact' ? 'whatsapp' : 'vip',
      customer.name, customer.email, customer.phone, customer.documentHash, customer.documentLast3, provider, grantType, resourceType, resourceId);
    if (!inserted.changes) {
      const raced = await db.get('SELECT * FROM orders WHERE checkout_hash = ?', checkoutHash);
      if (!raced) throw new Error('Checkout não persistido.');
      if (raced.product_id !== product.id || (product.type === 'tip' && Math.round(raced.amount * 100) !== Math.round(product.price * 100))) throw Object.assign(new Error('Checkout já pertence a outro produto.'), { status: 409 });
      return { ...raced, fresh: false };
    }
    await db.run("UPDATE orders SET creation_phase='ready' WHERE public_id=?", id);
    if(product.type === 'tip') await db.run("UPDATE orders SET purchase_kind='tip',access_type='tip',purchase_buyer_id=? WHERE public_id=?",buyerId,id);
    if(process.env.BUYER_ACCOUNT_FLOW === 'true' && product.type !== 'tip') await db.run('UPDATE orders SET claim_required=1,claim_token_hash=?,purchase_buyer_id=? WHERE public_id=?',checkoutHash,buyerId,id);
    return { ...await db.get('SELECT * FROM orders WHERE public_id = ?', id), fresh: true };
  });
}
async function getOrderByPublicId(id) { const order=await (await getDb()).get('SELECT * FROM orders WHERE public_id = ?', id); return require('../creator').ownsProduct(order?.product_id) ? order : undefined; }
async function updateOrderPayment(id, payment) {
  const result = await (await getDb()).run("UPDATE orders SET status='PENDING', creation_phase='complete', provider_payment_id=?, pix_copy_paste=?, pix_qr_code=?, webhook_token_hash=? WHERE public_id=? AND (status='CREATING' OR (status='FAILED' AND creation_phase='uncertain'))",
    payment.providerPaymentId, payment.pix.copyPaste, payment.pix.qrCode, payment.webhookToken ? hash(payment.webhookToken) : null, id);
  if (!result.changes) throw new Error('Payment persistence rejected');
  if(payment.expiresAt){const ms=Date.parse(payment.expiresAt);if(Number.isFinite(ms)&&ms>Date.now())await (await getDb()).run('UPDATE orders SET expires_at=? WHERE public_id=?',new Date(ms).toISOString().slice(0,19).replace('T',' '),id);}
}
// Claim before contacting the provider. A competing request may read the order,
// but only this atomic transition authorizes an outbound cash-in request.
async function beginPaymentCreation(id) {
  const result = await (await getDb()).run("UPDATE orders SET status='CREATING',creation_phase='requested',creation_started_at=? WHERE public_id=? AND provider_payment_id IS NULL AND pix_copy_paste IS NULL AND ((status='CREATING' AND creation_phase='ready') OR (status='FAILED' AND creation_phase='retryable'))", Date.now(), id);
  return Boolean(result.changes);
}
async function failPaymentCreation(id, safeToRetry) {
  await (await getDb()).run("UPDATE orders SET status='FAILED',creation_phase=? WHERE public_id=? AND status='CREATING' AND creation_phase='requested'", safeToRetry ? 'retryable' : 'uncertain', id);
}
const CREATION_TIMEOUT_MS = 120000;
async function recoverCreation(order) {
  if (!order || order.status !== 'CREATING' || order.creation_phase === 'ready') return order;
  const started = order.creation_started_at == null
    ? Date.parse(String(order.created_at).replace(' ', 'T') + 'Z') : Number(order.creation_started_at);
  if (!Number.isFinite(started) || Date.now() - started < CREATION_TIMEOUT_MS) return order;
  // A timeout does not prove cash-in failed. Never replay an ambiguous request.
  await (await getDb()).run("UPDATE orders SET status='FAILED',creation_phase='uncertain' WHERE public_id=? AND status='CREATING' AND creation_phase=? AND COALESCE(creation_started_at,0)=?", order.public_id, order.creation_phase, Number(order.creation_started_at) || 0);
  return getOrderByPublicId(order.public_id);
}
async function updateOrderStatus(id, status) {
  if (!['FAILED', 'EXPIRED', 'CANCELED'].includes(status)) throw new Error('Use confirmPayment for approval');
  await (await getDb()).run("UPDATE orders SET status=? WHERE public_id=? AND status IN ('CREATING','PENDING')", status, id);
}
module.exports = { createOrder, getOrderByPublicId, updateOrderPayment, updateOrderStatus, beginPaymentCreation, failPaymentCreation, recoverCreation, CREATION_TIMEOUT_MS };
