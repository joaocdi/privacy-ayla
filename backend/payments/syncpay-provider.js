'use strict';
const crypto = require('node:crypto');
const renderQrCode = require('./qrcode');
const BASE = 'https://api.syncpayments.com.br/api/partner/v1';
let cached, pendingAuth;
const unavailable = message => Object.assign(new Error(message), { status: 503 });
function configuration() {
  const clientId = process.env.SYNCPAY_CLIENT_ID;
  const clientSecret = process.env.SYNCPAY_CLIENT_SECRET;
  if (!clientId || !clientSecret || !process.env.SYNCPAY_WEBHOOK_SECRET) throw unavailable('SyncPay: configure as credenciais e o segredo oficial do webhook.');
  return { clientId, clientSecret };
}
async function accessToken() {
  const credentials = configuration();
  const key = crypto.createHash('sha256').update(credentials.clientId + ':' + credentials.clientSecret).digest('hex');
  if (cached?.key === key && cached.until > Date.now()) return cached.token;
  if (pendingAuth?.key === key) return pendingAuth.promise;
  const promise = (async () => {
    const response = await fetch(BASE + '/auth-token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Accept:'application/json', 'Content-Type':'application/json' },
      body: JSON.stringify({ client_id:credentials.clientId, client_secret:credentials.clientSecret })
    });
    if (!response.ok) throw unavailable('SyncPay auth HTTP ' + response.status);
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw unavailable('Resposta de autenticação SyncPay incompleta.');
    cached = { key, token:data.access_token, until:Date.now() + Math.max(0, Number(data.expires_in) - 60) * 1000 };
    return cached.token;
  })();
  pendingAuth = { key, promise };
  try { return await promise; } finally { if (pendingAuth?.promise === promise) pendingAuth = null; }
}
function validateSignature(raw, signature) {
  const secret = process.env.SYNCPAY_WEBHOOK_SECRET;
  if (!secret || !Buffer.isBuffer(raw) || typeof signature !== 'string') return false;
  const match = /^t=(\d{1,12}),\s*v1=([a-fA-F0-9]{64})$/.exec(signature.trim());
  if (!match || Math.abs(Math.floor(Date.now()/1000) - Number(match[1])) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(match[1] + '.').update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}
function parseWebhook(payload, headers) {
  if (!payload || typeof payload !== 'object' || typeof payload.event_id !== 'string' || !payload.event_id || payload.event_id.length > 200 || headers['x-syncpay-event'] !== payload.event || typeof headers['x-syncpay-delivery'] !== 'string' || !headers['x-syncpay-delivery']) throw Object.assign(new Error('Evento SyncPay inválido.'), {status:400});
  const tx = payload.transaction;
  if (!['transaction.updated','transaction.created'].includes(payload.event)) return { ignored:true };
  if (!tx || typeof tx.reference_id !== 'string' || !tx.reference_id || tx.reference_id.length > 200) throw Object.assign(new Error('Transação SyncPay inválida.'),{status:400});
  return { event:payload.event, providerPaymentId:tx.reference_id, amount:tx.amount, currency:tx.currency, method:tx.payment_method, paid:payload.event === 'transaction.updated' && tx.status === 'completed' };
}
module.exports = {
  name:'syncpay', requiresClient:false, configuration, validateSignature, parseWebhook,
  async createPixPayment({product}) {
    if (!Number.isFinite(product?.price) || product.price <= 0) throw new Error('Invalid catalog price');
    let token;
    try { token = await accessToken(); }
    catch (error) { error.paymentCreationSafeToRetry = true; throw error; }
    // Deliberately no retry: an ambiguous response may already have created PIX.
    const response = await fetch(BASE + '/cash-in', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(20000),
      headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:'Bearer ' + token },
      body:JSON.stringify({amount:product.price})
    });
    if (response.status === 401) cached = null;
    if (!response.ok) throw unavailable('SyncPay cash-in HTTP ' + response.status);
    const data = await response.json();
    if (typeof data.identifier !== 'string' || !data.identifier || data.identifier.length > 200 || typeof data.pix_code !== 'string' || !data.pix_code || data.pix_code.length > 10000) throw unavailable('Resposta PIX SyncPay incompleta.');
    return {status:'PENDING',providerPaymentId:data.identifier,expiresAt:typeof data.expires_at==='string'?data.expires_at:null,pix:{copyPaste:data.pix_code,qrCode:await renderQrCode(data.pix_code)}};
  }
};
