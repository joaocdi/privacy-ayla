const renderQrCode = require('./qrcode');
const { matches } = require('../services/security');
const DEFAULT_BASE_URL = 'https://app.sigilopay.com.br/api/v1';

/**
 * Base da API. Configurável por env (SIGILOPAY_BASE_URL) porque o endereço é
 * ambiente, não código — mas só https, e a chave secreta nunca sai daqui para
 * um host qualquer: um valor inválido derruba na hora em vez de virar
 * requisição autenticada para o lugar errado.
 */
function baseUrl() {
  const configured = (process.env.SIGILOPAY_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return DEFAULT_BASE_URL;
  let parsed;
  try { parsed = new URL(configured); } catch (_) { throw new Error('SIGILOPAY_BASE_URL inválida.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SIGILOPAY_BASE_URL precisa ser uma URL https simples.');
  }
  return configured;
}
function validateClient(client) {
  if (!client || typeof client !== 'object') return false;
  return typeof client.name === 'string' && client.name.trim().length >= 3 && client.name.length <= 150
    && typeof client.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email) && client.email.length <= 254
    && typeof client.phone === 'string' && /^[0-9()+\s-]{10,25}$/.test(client.phone) && [10,11,12,13].includes(client.phone.replace(/\D/g,'').length)
    && typeof client.document === 'string' && /^[0-9.\/\s-]+$/.test(client.document) && [11,14].includes(client.document.replace(/\D/g,'').length);
}
function configuration() {
  const publicKey = process.env.SIGILOPAY_PUBLIC_KEY;
  const secretKey = process.env.SIGILOPAY_SECRET_KEY;
  // O callback é derivado da URL pública da aplicação; SIGILOPAY_CALLBACK_URL
  // continua valendo como override explícito. Nada de localhost ou domínio fixo
  // no código: em produção a Vercel define PUBLIC_APP_URL.
  const publicAppUrl = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  const callbackUrl = process.env.SIGILOPAY_CALLBACK_URL
    || (publicAppUrl ? `${publicAppUrl}/api/payments/webhook` : '');
  if (!publicKey || !secretKey || !callbackUrl) throw Object.assign(new Error('SigiloPay não configurada.'), { status: 503 });
  const url = new URL(callbackUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/payments/webhook' || url.search || url.hash) throw new Error('Invalid SIGILOPAY_CALLBACK_URL');
  return { publicKey, secretKey, callbackUrl, baseUrl: baseUrl() };
}
module.exports = {
  name: 'sigilopay', requiresClient: true, validateClient, configuration,
  async createPixPayment({ orderId, product, client }) {
    if (!validateClient(client)) throw Object.assign(new Error('Preencha nome, e-mail, telefone e CPF/CNPJ.'), { status: 400 });
    const { publicKey, secretKey, callbackUrl, baseUrl: api } = configuration();
    const response = await fetch(api + '/gateway/pix/receive', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', 'x-public-key': publicKey, 'x-secret-key': secretKey },
      body: JSON.stringify({ identifier: orderId, amount: product.price,
        client: { name: client.name.trim(), email: client.email.trim(), phone: client.phone, document: client.document }, callbackUrl })
    });
    if (!response.ok) throw new Error('SigiloPay HTTP ' + response.status);
    const data = await response.json();
    if (!data.transactionId || typeof data.webhookToken !== 'string' || !data.webhookToken || typeof data.pix?.code !== 'string' || !data.pix.code) throw new Error('Incomplete SigiloPay response');
    // Generate locally from code: no dependence on deprecated base64 or third-party image availability.
    return { status: 'PENDING', providerPaymentId: String(data.transactionId), webhookToken: data.webhookToken,
      pix: { copyPaste: data.pix.code, qrCode: await renderQrCode(data.pix.code) } };
  },
  validateWebhook(payload, order) { return order?.payment_provider === 'sigilopay' && matches(payload?.token, order.webhook_token_hash); },
  parseWebhook(payload) { return { event: payload?.event, providerPaymentId: payload?.transactionId }; }
};
