require('./sqlite-env');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
process.env.DATABASE_PATH = path.resolve(__dirname, '../.test-runs/syncpay-' + crypto.randomUUID() + '.sqlite');
Object.assign(process.env, { PAYMENT_PROVIDER:'syncpay', SYNCPAY_CLIENT_ID:'fixture-id', SYNCPAY_CLIENT_SECRET:'fixture-secret', SYNCPAY_WEBHOOK_SECRET:'fixture-webhook', WHATSAPP_NUMBER:'5548999990000' });
const originalFetch = global.fetch, calls = [];
global.fetch = async (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
  assert.ok(String(url).startsWith('https://api.syncpayments.com.br/api/partner/v1/'));
  const body = JSON.parse(options.body); calls.push({url, body});
  if (url.endsWith('/auth-token')) return Response.json({access_token:'fixture-token', expires_in:3600});
  assert.ok(url.endsWith('/cash-in'));
  assert.deepEqual(Object.keys(body), ['amount'], 'no personal data or client may leave backend');
  assert.equal(options.headers.Authorization, 'Bearer fixture-token');
  return Response.json({identifier:crypto.randomUUID(), pix_code:'fixture-pix-code'});
};
const {app} = require('../server'), database = require('../db/database'), provider = require('../payments/syncpay-provider');
let server;
(async () => {
  await database.initDb(); server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port, db = await database.getDb();
  async function request(route, body, token) {
    const response = await fetch(base + route, {method:body ? 'POST':'GET', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + token}, body:body ? JSON.stringify(body):undefined});
    return {status:response.status, data:await response.json()};
  }
  async function webhook(identifier, amount, change = {}, invalid = false, timestamp = Math.floor(Date.now()/1000)) {
    const payload = {event:'transaction.updated', event_id:'fixture-event', transaction:{reference_id:identifier, status:'completed', amount, currency:'BRL', payment_method:'pix', ...change}};
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.SYNCPAY_WEBHOOK_SECRET).update(timestamp + '.' + raw).digest('hex');
    return fetch(base + '/api/webhooks/syncpay', {method:'POST', headers:{'Content-Type':'application/json', 'X-SyncPay-Event':payload.event, 'X-SyncPay-Delivery':crypto.randomUUID(), 'X-SyncPay-Signature':'t=' + timestamp + ',v1=' + (invalid ? '0'.repeat(64):signature)}, body:raw});
  }
  for (const [productId, amount, days] of [['ayla_monthly',9.9,30], ['ayla_quarterly',19.9,90], ['ayla_semester',29.9,180], ['ayla_whatsapp_unlock',7.9,null]]) {
    const token = crypto.randomBytes(32).toString('hex');
    const input = {productId, checkoutToken:token, amount:0.01, client:{phone:'(11) 99999-0000', name:'must not send', email:'private@example.invalid', cpf:'12345678900'}};
    const created = await request('/api/payments/pix', input, token);
    assert.equal(created.status,201); assert.equal(created.data.product.price,amount);
    assert.match(created.data.pix.qrCode,/^data:image\/png;base64,/);
    const id = created.data.orderId, order = await db.get('SELECT * FROM orders WHERE public_id=?',id);
    assert.ok(order.provider_payment_id); assert.equal(order.payment_provider,'syncpay'); assert.equal(order.customer_phone,'5511999990000');
    assert.equal(order.customer_name,null); assert.equal(order.customer_email,null); assert.equal(order.status,'PENDING');
    assert.equal(calls.at(-1).body.amount, amount);
    const count = calls.length;
    assert.equal((await request('/api/payments/pix',input,token)).data.orderId,id); assert.equal(calls.length,count);
    assert.equal((await webhook(order.provider_payment_id,amount,{},true)).status,401);
    assert.equal((await webhook(order.provider_payment_id,amount,{},false,1)).status,401);
    assert.equal((await webhook(order.provider_payment_id,amount+1)).status,409);
    // Conta SyncPay compartilhada: transação de outra criadora é reconhecida
    // e ignorada (sem 404 em série), e não muda nada no banco desta casa.
    const antesEstrangeira = await db.get("SELECT (SELECT COUNT(*) FROM orders) AS pedidos, (SELECT COUNT(*) FROM entitlements) AS acessos");
    const estrangeira = await webhook('unknown',amount);
    assert.equal(estrangeira.status,200);
    assert.equal((await estrangeira.json()).ignored,true);
    assert.deepEqual(await db.get("SELECT (SELECT COUNT(*) FROM orders) AS pedidos, (SELECT COUNT(*) FROM entitlements) AS acessos"), antesEstrangeira);
    assert.equal((await webhook(order.provider_payment_id,amount,{payment_method:'card'})).status,409);
    assert.equal((await webhook(order.provider_payment_id,amount,{currency:'USD'})).status,409);
    assert.equal((await webhook(order.provider_payment_id,amount,{status:'pending'})).status,200);
    assert.equal((await request('/api/orders/'+id+'/status',null,token)).data.status,'PENDING');
    for (const response of await Promise.all([webhook(order.provider_payment_id,amount),webhook(order.provider_payment_id,amount)])) assert.equal(response.status,200);
    assert.equal((await webhook(order.provider_payment_id,amount+1)).status,409);
    const paid = await db.get('SELECT * FROM orders WHERE id=?',order.id);
    assert.equal(paid.status,'PAID'); assert.equal(paid.amount,amount); assert.ok(paid.paid_at);
    const grants = await db.all('SELECT * FROM entitlements WHERE order_id=?',order.id);
    assert.equal(grants.length,1); assert.equal(grants[0].status,'ACTIVE');
    assert.equal(grants[0].product_id,productId);
    if (days) assert.equal((Date.parse(grants[0].expires_at)-Date.parse(grants[0].starts_at))/86400000,days);
    else assert.equal(grants[0].expires_at,null);
    const status = (await request('/api/orders/'+id+'/status',null,token)).data;
    assert.equal(status.granted,Boolean(days)); assert.equal(status.contactGranted,!days);
    assert.equal((await request('/api/orders/'+id+'/status',null,'0'.repeat(64))).status,403);
    assert.equal((await request('/api/vip/'+id,null,token)).status,days ? 200:403);
    if (!days) for(let i=0;i<2;i++) assert.equal((await request('/api/contact/'+id,null,token)).status,200);
  }
  assert.equal(calls.filter(c=>c.url.endsWith('/auth-token')).length,1,'token reused for all products');
  const realNow = Date.now;
  try {
    Date.now = () => realNow()+3550*1000;
    await Promise.all([provider.createPixPayment({product:{price:9.9}}),provider.createPixPayment({product:{price:9.9}})]);
    assert.equal(calls.filter(c=>c.url.endsWith('/auth-token')).length,2,'one shared refresh near expiry');
  } finally { Date.now = realNow; }
  await assert.rejects(db.run('UPDATE orders SET provider_payment_id=(SELECT provider_payment_id FROM orders WHERE product_id=?) WHERE product_id=?','ayla_monthly','ayla_quarterly'),/UNIQUE/);
  const raw = Buffer.from('{ "fixture": true }'), t = Math.floor(Date.now()/1000);
  const sig = 't='+t+',v1='+crypto.createHmac('sha256',process.env.SYNCPAY_WEBHOOK_SECRET).update(t+'.').update(raw).digest('hex');
  assert.ok(provider.validateSignature(raw,sig)); assert.equal(provider.validateSignature(Buffer.from('{"fixture":true}'),sig),false);
  // Pending SigiloPay orders still reconcile after switching the active provider.
  const legacy = await require('../services/orders').createOrder(require('../products').ayla_monthly,crypto.randomBytes(32).toString('hex'),'sigilopay');
  await require('../services/orders').updateOrderPayment(legacy.public_id,{providerPaymentId:'legacy-id',webhookToken:'legacy-token',pix:{copyPaste:'fixture',qrCode:'fixture'}});
  assert.equal((await request('/api/payments/webhook',{token:'legacy-token',transactionId:'legacy-id',event:'TRANSACTION_PAID'})).status,200);
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?',legacy.id)).status,'PAID');
  delete process.env.SYNCPAY_WEBHOOK_SECRET;
  assert.throws(()=>provider.configuration(),/webhook/);
  process.env.SYNCPAY_WEBHOOK_SECRET='fixture-webhook';
  let failures=0;
  global.fetch=async()=>{failures++;return new Response('',{status:401})};
  await assert.rejects(provider.createPixPayment({product:{price:9.9}}));
  assert.equal(failures,1,'ambiguous charge failure is never retried');
  console.log('PASS SyncPay: four products, catalog amounts, no personal data, local QR, cached/concurrent auth refresh, unique identifiers, signed raw webhook, invalid/old signatures, duplicate delivery, amount/method/currency mismatch, unknown transaction, unique scoped grants and access ownership');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{global.fetch=originalFetch;if(server)await new Promise(r=>server.close(r));await database.closeDb()});
