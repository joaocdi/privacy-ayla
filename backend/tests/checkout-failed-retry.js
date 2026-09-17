require('./sqlite-env');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
Object.assign(process.env, {
  BUYER_ACCOUNT_FLOW: 'true', PAYMENT_PROVIDER: 'mock',
  DATABASE_PATH: path.resolve(__dirname, '../.test-runs/failed-retry-' + crypto.randomUUID() + '.sqlite')
});
const { app } = require('../server');
const db = require('../db/database');
const provider = require('../payments/provider');
const { chromium } = require('../.test-runs/browser/node_modules/playwright');
const create = provider.createPixPayment;
let server, browser, calls = 0;
provider.createPixPayment = async input => {
  calls++;
  if (calls === 1) throw Object.assign(new Error('Fixture: provider unavailable before PIX'), { status: 503, paymentCreationSafeToRetry: true });
  return create(input);
};

(async () => {
  await db.initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.PUBLIC_APP_URL = base;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  await page.goto(base);
  await page.locator('#ageConfirm').click();
  await page.locator('#btnPlan1m').click();
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor();
  const failedToken = await page.evaluate(() => sessionStorage.getItem('ayla.checkout.ayla_monthly'));
  const failedOrder = await (await db.getDb()).get('SELECT * FROM orders WHERE checkout_hash=?', require('../services/security').hash(failedToken));
  assert.equal(failedOrder.status, 'FAILED');
  assert.equal(failedOrder.provider_payment_id, null);
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await page.locator('#pixActiveArea').waitFor({ state: 'visible' });
  const nextToken = await page.evaluate(() => sessionStorage.getItem('ayla.checkout.ayla_monthly'));
  assert.equal(nextToken, failedToken);
  assert.equal(calls, 2);
  const pending = await page.evaluate(() => AylaCheckouts.selected());
  const orders = await (await db.getDb()).all('SELECT * FROM orders ORDER BY id');
  assert.equal(orders.length, 1);
  assert.equal(orders.filter(order => order.status === 'PENDING').length, 1);
  assert.equal(pending.payment.orderId, orders.find(order => order.status === 'PENDING').public_id);
  const response = await fetch(base + '/api/payments/pix', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: 'ayla_monthly', checkoutToken: failedToken })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).orderId, failedOrder.public_id);
  assert.equal(calls, 2);
  await (await db.getDb()).run("UPDATE orders SET status='FAILED' WHERE public_id=?", pending.payment.orderId);
  const ambiguous = await fetch(base + '/api/payments/pix', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: 'ayla_monthly', checkoutToken: nextToken })
  });
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json()).requiresReview, true);
  assert.equal(calls, 2);
  console.log('PASS failed PIX: safe failure resumes same order/token; ambiguous charge cannot duplicate');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  provider.createPixPayment = create;
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.closeDb();
});
