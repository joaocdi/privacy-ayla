const crypto = require('crypto');
const renderQrCode = require('./qrcode');
const { matches } = require('../services/security');
module.exports = {
  name: 'mock', requiresClient: false,
  async createPixPayment({ orderId }) {
    const code = 'SIMULACAO-SEM-VALOR-PIX-' + orderId;
    return { status: 'PENDING', providerPaymentId: 'mock_' + crypto.randomUUID(), webhookToken: crypto.randomBytes(32).toString('hex'), pix: { copyPaste: code, qrCode: await renderQrCode(code) } };
  },
  validateWebhook(payload, order) { return order?.payment_provider === 'mock' && matches(payload?.token, order.webhook_token_hash); },
  parseWebhook(payload) { return { event: payload?.event, providerPaymentId: payload?.transactionId }; }
};
