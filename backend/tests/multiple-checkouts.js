require('./sqlite-env');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
Object.assign(process.env, { BUYER_ACCOUNT_FLOW: 'true', PAYMENT_PROVIDER: 'mock', WHATSAPP_NUMBER: '5511999990000', DATABASE_PATH: path.resolve(__dirname, '../.test-runs/multi-' + crypto.randomUUID() + '.sqlite'), SUPABASE_URL: 'https://auth.invalid', SUPABASE_ANON_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service' });
const uid = crypto.randomUUID(), realFetch = global.fetch;
global.fetch = async (url, options) => String(url).startsWith('https://auth.invalid')
  ? Response.json(String(url).endsWith('/user') ? { id: uid, email: 'multi@example.test' } : { access_token: 'fixture', user: { id: uid, email: 'multi@example.test' } })
  : realFetch(url, options);
const { app } = require('../server'), db = require('../db/database');
const { confirmPayment } = require('../services/entitlements');
const { chromium } = require('../.test-runs/browser/node_modules/playwright');
let server, browser;
(async () => {
  await db.initDb(); server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port; process.env.PUBLIC_APP_URL = base;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const first = await context.newPage(), second = await context.newPage();
  for (const page of [first, second]) { await page.goto(base); if (await page.locator('#ageGate').isVisible()) await page.locator('#ageConfirm').click(); }
  let dropped = false;
  await first.route('**/api/payments/pix', async route => {
    if (dropped) return route.continue();
    dropped = true; await route.fetch(); await route.abort('connectionfailed');
  });
  await Promise.all([first.locator('#btnPlan1m').click(), second.evaluate(() => openCheckout('ayla_whatsapp_unlock'))]);
  await first.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor();
  await second.locator('#pixActiveArea').waitFor({ state: 'visible' });
  await second.evaluate(() => closeCheckout());
  await first.reload(); await first.locator('#pixNotificationBell').waitFor({ state: 'visible' });
  await first.locator('#pixNotificationBell').click(); assert.equal(await first.locator('#pixNotificationContinue').count(), 1);
  assert.equal(await first.locator('#checkoutModalOverlay').evaluate(e => e.classList.contains('open')), false);
  await first.evaluate(() => openCheckout('ayla_monthly')); await first.locator('#pixActiveArea').waitFor({ state: 'visible' });
  const entries = await first.evaluate(() => AylaCheckouts.list());
  assert.equal(entries.length, 2);
  const ayla_monthly = entries.find(item => item.productId === 'ayla_monthly'), contact = entries.find(item => item.productId === 'ayla_whatsapp_unlock');
  assert.notEqual(ayla_monthly.token, contact.token); assert.notEqual(ayla_monthly.payment.orderId, contact.payment.orderId);
  assert.equal(await first.evaluate(() => AylaCheckouts.selected().productId), 'ayla_monthly');
  assert.equal(await second.evaluate(() => AylaCheckouts.selected().productId), 'ayla_whatsapp_unlock');
  assert.equal((await (await db.getDb()).get('SELECT COUNT(*) n FROM orders')).n, 2);
  // Import old browser data without overwriting the other purchase/tab selection.
  await second.evaluate(item => { localStorage.setItem('ayla.buyer.pending', JSON.stringify(item)); AylaCheckouts.list(); }, ayla_monthly);
  assert.equal(await second.evaluate(() => AylaCheckouts.list().length), 2);
  assert.equal(await second.evaluate(() => localStorage.getItem('ayla.buyer.pending')), null);
  assert.equal(await second.evaluate(() => AylaCheckouts.selected().productId), 'ayla_whatsapp_unlock');
  await confirmPayment(ayla_monthly.payment.orderId);
  await first.waitForURL(/\/criar-acesso\?order=/);
  assert.equal(new URL(first.url()).searchParams.get('order'), ayla_monthly.payment.orderId);
  await first.locator('#accountForm').waitFor({ state: 'visible' });
  for (const [name, value] of Object.entries({ email: 'multi@example.test', phone: '11999990000', password: 'test-password', confirmPassword: 'test-password' })) await first.locator('[name=' + name + ']').fill(value);
  await first.locator('#submit').click(); await first.waitForURL('**/meu-acesso');
  assert.deepEqual(await first.evaluate(() => AylaCheckouts.list().map(item => item.productId)), ['ayla_whatsapp_unlock']);
  await confirmPayment(contact.payment.orderId);
  await second.reload(); await second.locator('#pixNotificationBell').click(); await second.getByRole('button', { name: 'Criar meu acesso', exact: true }).click();
  await second.waitForURL('**/meu-acesso'); await second.getByRole('button', { name: 'Abrir meu WhatsApp' }).waitFor();
  assert.equal(await second.evaluate(() => AylaCheckouts.list().length), 0);
  const rows = await (await db.getDb()).all('SELECT o.public_id,o.buyer_id,e.grant_type,e.expires_at FROM orders o JOIN entitlements e ON e.order_id=o.id ORDER BY o.id');
  assert.equal(rows.length, 2); assert(rows.every(row => row.buyer_id === uid));
  assert(rows.find(row => row.grant_type === 'subscription').expires_at);
  assert.equal(rows.find(row => row.grant_type === 'contact').expires_at, null);
  console.log('PASS multi checkout: two tabs/products, lost response + reload, legacy migration, correct claim selection, signup preserves other purchase, same buyer, unique separate grants');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.closeDb(); global.fetch = realFetch;
});
