require('./sqlite-env');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.BUYER_ACCOUNT_FLOW = 'true';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.DATABASE_PATH = path.resolve(__dirname, '../.test-runs/final-polish-' + crypto.randomUUID() + '.sqlite');
const { app } = require('../server');
const database = require('../db/database');
const { chromium } = require('../.test-runs/browser/node_modules/playwright');
const creator = require('../vip-content').profile.name.toLowerCase();
const product = Object.values(require('../products')).find(p => p.accessDays === 30);
const preview = 'data:image/jpeg;base64,' + fs.readFileSync(path.resolve(__dirname, '../../previews/post-01.jpg')).toString('base64');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser;

async function main() {
  await database.initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const db = await database.getDb();
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const item = (id, type, likes_count, items) => ({ id, type, preview, caption: 'Publicação ' + id, likes_count, items });
  const carousel = [0, 1].map(n => ({ id: 'slide-' + n, type: 'image', preview, crop: { ratio: '4:5', x: 50, y: 50, zoom: 1 } }));
  const first = [item('photo-1', 'image', 81), item('video-1', 'video', null), item('carousel-1', 'image', 27, carousel), item('photo-2', 'image', 0), item('video-2', 'video', 90), { id: 'invalid', preview: '' }];
  const second = [item('photo-4', 'image', 18), item('video-3', 'video', null)];
  const third = [item('photo-3', 'image', null)];
  const requestedOffsets = [];
  await page.route(url => url.pathname === '/api/home/previews', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0);
    requestedOffsets.push(offset);
    return route.fulfill({ json: { source: 'managed', total: 9, previews: offset === 0 ? first : offset === 6 ? second : offset === 8 ? third : [] } });
  });

  await page.goto(base + '/');
  assert.equal(await page.locator('#ageGate').isVisible(), true);
  assert.equal(await page.locator('#pixNotificationBadge').isVisible(), false);
  await page.locator('#ageConfirm').click();
  const ageKey = creator + '.age_gate_confirmed_v1';
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).accepted, ageKey), true);
  await page.locator('.preview-post[data-post-id="photo-1"]').waitFor();
  await page.locator('.feed-sentinela').scrollIntoViewIfNeeded();
  await page.locator('.preview-post[data-post-id="video-3"]').waitFor();
  await page.locator('.feed-sentinela').scrollIntoViewIfNeeded();
  await page.locator('.preview-post[data-post-id="photo-3"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.preview-actions .tip-trigger').length === 8);
  const posts = await page.evaluate(() => ({
    count: document.querySelectorAll('.preview-post').length,
    nested: document.querySelectorAll('.preview-post .preview-post').length,
    loose: document.querySelectorAll('#contentTabs > .preview-actions, #contentTabs > .preview-engagement, #contentTabs > .tip-trigger').length,
    invalid: [...document.querySelectorAll('.preview-post')].filter(card => card.querySelectorAll(':scope > .preview-actions').length !== 1 || card.querySelectorAll(':scope > .preview-engagement').length !== 1 || card.querySelectorAll(':scope > .preview-actions .tip-trigger').length !== 1).length
  }));
  assert.deepEqual(posts, { count: 8, nested: 0, loose: 0, invalid: 0 });
  assert.deepEqual(requestedOffsets.slice(0, 3), [0, 6, 8], 'pagination uses raw offset despite invalid preview');
  assert.equal(await page.locator('.preview-post[data-post-id="carousel-1"] .car-track').count(), 1);
  assert.equal(await page.locator('.preview-post[data-post-id="video-1"] .locked-post').count(), 1);
  assert.equal(await page.locator('.preview-post[data-post-id="photo-1"] .preview-engagement').count(), 1);
  assert.equal(await page.locator('.preview-post[data-post-id="photo-2"] .preview-engagement').count(), 1);
  await page.reload();
  assert.equal(await page.locator('#ageGate').isVisible(), false, 'refresh keeps age confirmation');
  await page.goto(base + '/continuar');
  await page.goto(base + '/');
  assert.equal(await page.locator('#ageGate').isVisible(), false, 'navigation keeps age confirmation');
  for (const route of ['/login', '/meu-acesso', '/vip']) {
    await page.goto(base + route);
    await page.goto(base + '/');
    assert.equal(await page.locator('#ageGate').isVisible(), false, route + ' keeps age confirmation');
  }
  for (let tries = 0; tries < 30; tries++) { if ((await db.get("SELECT COUNT(*) n FROM analytics_events WHERE event_name='age_gate_confirm'")).n === 1) break; await wait(100); }
  assert.equal((await db.get("SELECT COUNT(*) n FROM analytics_events WHERE event_name='age_gate_confirm'")).n, 1);
  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(base + '/');
  assert.equal(await freshPage.locator('#ageGate').isVisible(), true, 'clean storage shows age gate');
  await fresh.close();

  assert.equal(await page.locator('.home-footer .footer-links a').count(), 4);
  await page.locator('.home-footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve(__dirname, '../.test-runs/final-polish-footer-' + creator + '.png') });

  await page.evaluate(id => openCheckout(id), product.id);
  await page.locator('#pixActiveArea').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.resolve(__dirname, '../.test-runs/final-polish-checkout-' + creator + '.png') });
  const order = await page.evaluate(() => (window.AylaCheckouts || window.JoiceCheckouts).selected().payment.orderId);
  assert.equal((await db.get('SELECT status FROM orders WHERE public_id=?', order)).status, 'PENDING');
  await db.run('UPDATE orders SET expires_at=NULL WHERE public_id=?', order);
  await page.reload();
  await page.locator('#pixNotificationBadge').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pixNotificationBadge').textContent(), '1');
  await page.locator('#pixNotificationBell').click();
  await page.screenshot({ path: path.resolve(__dirname, '../.test-runs/final-polish-bell-' + creator + '.png') });
  assert.equal((await page.locator('#pixNotificationPanel .pix-notification-detail').textContent()).replace(/\s/g, ' '), '1 mês · R$ 9,90');
  assert.equal(await page.locator('#pixNotificationTime').count(), 0);
  assert.equal(await page.locator('#pixNotificationPanel').textContent().then(s => /operador|SyncPay|validade desconhecida|Prazo não informado/i.test(s)), false);
  await page.locator('.pix-notification-close').click();
  assert.equal(await page.locator('#pixNotificationPanel').isVisible(), false);
  assert.equal((await db.get('SELECT status FROM orders WHERE public_id=?', order)).status, 'PENDING', 'closing panel does not cancel');
  await page.reload();
  await page.locator('#pixNotificationBadge').waitFor({ state: 'visible' });
  await page.locator('#pixNotificationBell').click();
  await page.locator('#pixNotificationContinue').click();
  await page.waitForURL('**/continuar?order=' + order);
  await page.locator('#pix').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#remaining').isVisible(), false);
  await require('../services/entitlements').confirmPayment(order);
  await page.goto(base + '/');
  await page.locator('#pixNotificationBell').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pixNotificationBadge').isVisible(), false, 'paid checkout has no pending badge');
  await page.locator('#pixNotificationBell').click();
  assert.equal(await page.locator('#pixNotificationContinue').textContent(), 'Criar meu acesso');

  for (const width of [320, 375, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
      account: !!document.querySelector('.member-link'), bell: !!document.querySelector('#pixNotificationBell'),
      panel: document.querySelector('#pixNotificationPanel').getBoundingClientRect().toJSON() }));
    assert.equal(layout.overflow, false, 'horizontal overflow at ' + width);
    assert.ok(layout.account && layout.bell);
    assert.ok(layout.panel.left >= 0 && layout.panel.right <= width + 1, 'panel fits at ' + width);
  }
  await page.evaluate(key => localStorage.removeItem(key), ageKey);
  await page.reload();
  assert.equal(await page.locator('#ageGate').isVisible(), true, 'cleared storage shows age gate again');
  console.log('PASS ' + creator + ': age once, eight paged posts with one footer/actions, bell recovery, no technical expiry text, close safety, paid badge removal, 320/375/390/430/1280');
  await context.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await database.closeDb();
});
