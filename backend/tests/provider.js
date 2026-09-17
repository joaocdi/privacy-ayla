const assert = require('node:assert/strict');
const { hash } = require('../services/security');
const provider = require('../payments/sigilopay-provider');
const realFetch = global.fetch;
process.env.SIGILOPAY_PUBLIC_KEY = 'test-public';
process.env.SIGILOPAY_SECRET_KEY = 'test-secret';
process.env.SIGILOPAY_CALLBACK_URL = 'https://example.com/api/payments/webhook';
const client = { name:'Cliente Teste', email:'teste@example.com', phone:'11999999999', document:'12345678901' };
async function main() {
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://app.sigilopay.com.br/api/v1/gateway/pix/receive');
    assert.equal(options.headers['x-public-key'], 'test-public');
    assert.equal(options.headers['x-secret-key'], 'test-secret');
    assert.deepEqual(JSON.parse(options.body), { identifier:'order-test', amount:9.9, client, callbackUrl:process.env.SIGILOPAY_CALLBACK_URL });
    return { ok:true, json:async () => ({ transactionId:'tx-test', webhookToken:'test-hook', pix:{code:'test-pix-code'}, transactionStatus:'PAID' }) };
  };
  const payment = await provider.createPixPayment({ orderId:'order-test', product:{price:9.9}, client });
  assert.equal(payment.status, 'PENDING'); // Creation response can never approve access.
  assert.equal(payment.providerPaymentId, 'tx-test');
  assert.match(payment.pix.qrCode, /^data:image\/png;base64,/);
  const order = { payment_provider:'sigilopay', webhook_token_hash:hash('test-hook') };
  assert.equal(provider.validateWebhook({token:'test-hook'}, order), true);
  assert.equal(provider.validateWebhook({token:'wrong'}, order), false);
  assert.equal(provider.parseWebhook({event:'TRANSACTION_PAID'}).event,'TRANSACTION_PAID');
  await assert.rejects(provider.createPixPayment({orderId:'x',product:{price:9.9},client:{}}));
  assert.equal(calls,1);
  global.fetch = async () => ({ ok:true, json:async()=>({ transactionId:'x', pix:{code:'test'} }) });
  await assert.rejects(provider.createPixPayment({orderId:'x',product:{price:9.9},client}));
  global.fetch = async () => ({ok:false,status:503});
  await assert.rejects(provider.createPixPayment({orderId:'x',product:{price:9.9},client}));
  console.log('PASS: SigiloPay request contract, validation, missing token, HTTP failure, QR fallback');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=realFetch;});
