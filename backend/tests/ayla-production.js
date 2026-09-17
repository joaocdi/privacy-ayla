// Produção da Ayla, pelo MESMO handler da Vercel (api/index.js), em PostgreSQL
// (PGlite em memória, ou um PostgreSQL real de teste via TEST_SETUP_PG_ADMIN_URL).
//  - sem provider / mock em produção: site no ar, checkout 503, mock nunca carrega;
//  - SyncPay: preços só do backend, PIX, webhook assinado, idempotência,
//    entitlements só da Ayla, WhatsApp separado do VIP.
// SyncPay e Supabase são simulados. Nenhuma cobrança, nenhum serviço externo.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scenario = process.argv[2];
const WEBHOOK_SECRET = crypto.randomBytes(24).toString('hex');
const CLIENT_SECRET = 'cs_' + crypto.randomBytes(12).toString('hex');
const ORIGIN = 'https://privacy-ayla.vercel.app';

/* ============================================================ processo pai */
if (!scenario) {
  const { Client } = require('pg');
  const adminUrl = process.env.TEST_SETUP_PG_ADMIN_URL;
  (async () => {
    let realDb = null, admin = null;
    if (adminUrl) {
      admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      const name = 'ayla_prod_' + crypto.randomBytes(4).toString('hex');
      const user = 'ayla_owner_' + crypto.randomBytes(3).toString('hex');
      const pass = 'Pw@' + crypto.randomBytes(8).toString('hex');
      await admin.query(`CREATE ROLE ${user} LOGIN PASSWORD '${pass}'`);
      await admin.query(`CREATE DATABASE ${name} OWNER ${user}`);
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$`);
      const u = new URL(adminUrl);
      realDb = { name, user, url: ['postgresql', '://', user, ':', encodeURIComponent(pass), '@', u.hostname, ':', u.port, '/', name].join('') };
    }
    try {
      for (const s of ['sem-provider', 'mock', 'syncpay']) {
        const r = spawnSync(process.execPath, [__filename, s], {
          encoding: 'utf8', timeout: 180000,
          env: { PATH: process.env.PATH, TEST_REAL_DB: realDb ? realDb.url : '', DOTENV_CONFIG_QUIET: 'true' }
        });
        const out = (r.stdout || '') + (r.stderr || '');
        if (r.status !== 0) { console.error(out); throw new Error('cenário falhou: ' + s); }
        assert.ok(!out.includes('Mock payments are forbidden'), 'mensagem antiga do crash não aparece');
        for (const secret of [WEBHOOK_SECRET, CLIENT_SECRET]) assert.ok(!out.includes(secret));
        process.stdout.write(out.split('\n').filter(l => l.startsWith('PASS')).join('\n') + '\n');
      }
    } finally {
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${realDb.name} WITH (FORCE)`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS ${realDb.user}`).catch(() => {});
        await admin.end();
      }
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
  return;
}

/* ============================================================ processo filho */
const realDbUrl = process.env.TEST_REAL_DB;
let engine = null;
if (!realDbUrl) {
  const { PGlite } = require('@electric-sql/pglite');
  engine = new PGlite();
  class Pool {
    on() {}
    async query(sql, values = []) {
      const r = values.length ? await engine.query(sql, values) : (await engine.exec(sql)).at(-1);
      // PGlite returns timestamp columns as Date in the host timezone. The real
      // pg adapter returns UTC-style SQL strings, so emulate that contract.
      const timestamp = d => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-')+' '+[d.getHours(),d.getMinutes(),d.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
      const rows=(r?.rows||[]).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?timestamp(value):value])));
      return { rows, rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    }
    async connect() { return { query: Pool.prototype.query.bind(this), release() {} }; }
    async end() {}
  }
  Object.defineProperty(require('pg'), 'Pool', { value: Pool });
}

const env = {
  NODE_ENV: 'production', APP_ENV: 'production', VERCEL: '1',
  DATABASE_URL: realDbUrl || 'postgresql://pglite:pglite@localhost:5432/pglite', PGSSL: 'disable',
  DATABASE_SCHEMA: 'ayla', CREATOR_SLUG: 'ayla',
  VIP_MEDIA_DRIVER: 'supabase', VIP_MEDIA_BUCKET: 'vip-ayla', VIP_MEDIA_SECRET: crypto.randomBytes(32).toString('hex'),
  SUPABASE_URL: ['https://', 'exemploayla', '.supabase', '.co'].join(''), SUPABASE_SERVICE_ROLE_KEY: 'srv-test', SUPABASE_ANON_KEY: 'anon-test',
  ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('hex'), CRON_SECRET: crypto.randomBytes(32).toString('hex'),
  PUBLIC_APP_URL: ORIGIN, FRONTEND_URL: ORIGIN, ADMIN_ORIGIN: ORIGIN, BUYER_ACCOUNT_FLOW: 'true',
  ENABLE_TELEGRAM_BOT: 'false', TELEGRAM_BOT_USERNAME: 'aylabl0nde_bot', WHATSAPP_NUMBER: '5511999990000', WHATSAPP_PRICE: '7.90',
  STAGING_DATABASE_SCHEMA: '', SYNCPAY_CLIENT_ID: '', SYNCPAY_CLIENT_SECRET: '', SYNCPAY_WEBHOOK_SECRET: '',
  PAYMENT_PROVIDER: scenario === 'syncpay' ? 'syncpay' : scenario === 'mock' ? 'mock' : ''
};
if (scenario === 'syncpay') Object.assign(env, { SYNCPAY_CLIENT_ID: 'ci_test', SYNCPAY_CLIENT_SECRET: CLIENT_SECRET, SYNCPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
Object.assign(process.env, env);

// Rede: só a SyncPay simulada responde. Qualquer outra chamada externa falha.
const syncpayCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (target, init = {}) => {
  const url = String(target);
  if (url.startsWith('http://127.0.0.1')) return realFetch(target, init);
  if (url === 'https://api.syncpayments.com.br/api/partner/v1/auth-token') {
    syncpayCalls.push({ kind: 'auth', body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ access_token: 'tok_test', expires_in: 3600 }), { status: 200 });
  }
  if (url === 'https://api.syncpayments.com.br/api/partner/v1/cash-in') {
    const body = JSON.parse(init.body);
    syncpayCalls.push({ kind: 'cash-in', body });
    assert.equal(init.headers.Authorization, 'Bearer tok_test');
    return new Response(JSON.stringify({ identifier: 'sp_' + crypto.randomUUID(), pix_code: '00020126PIXTESTE' + body.amount }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const http = require('node:http');
(async () => {
  const pre = realDbUrl ? new (require('pg').Client)({ connectionString: realDbUrl }) : null;
  if (pre) { await pre.connect(); await pre.query('CREATE SCHEMA IF NOT EXISTS ayla'); }
  else await engine.exec('CREATE SCHEMA ayla');

  const handler = require('../../api/index.js');
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(r => server.listen(0, '0.0.0.0', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  // O checkout limita 10 PIX/min por IP (proteção real); cada chamada sai de um IP de loopback diferente.
  let clientIp = 1;
  const call = (route, { method = 'GET', body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request(base + route, {
      method, localAddress: '127.0.0.' + (1 + (clientIp++ % 250)),
      headers: { 'content-type': 'application/json', ...headers, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  const db = await require('../db/database').getDb();
  const token = () => crypto.randomBytes(32).toString('hex');

  try {
    // ---------------------------------------------------- páginas sempre no ar
    const home = await call('/');
    assert.equal(home.status, 200, 'GET /');
    assert.match(home.text, /<html/i);
    assert.ok((await call('/favicon.ico')).status < 500, 'favicon sem 500');
    for (const page of ['/login', '/redefinir-senha', '/esqueci-senha', '/criadora/login', '/vip']) {
      assert.equal((await call(page)).status, 200, page);
    }
    assert.ok([200, 303].includes((await call('/meu-acesso')).status), '/meu-acesso');
    const catalog = await call('/api/catalog');
    assert.equal(catalog.status, 200);
    const prices = Object.fromEntries(catalog.json.products.map(p => [p.id, p.price]));
    assert.deepEqual(prices, { ayla_tip: 5, ayla_whatsapp_unlock: 7.9, ayla_monthly: 9.9, ayla_quarterly: 19.9, ayla_semester: 29.9 });
    assert.equal(catalog.json.mock, false, 'produção nunca se apresenta como simulada');
    assert.equal((await call('/api/dev/orders/x/pay', { method: 'POST', body: {} })).status, 404, 'rota de pagamento simulado ausente');

    if (scenario !== 'syncpay') {
      const health = await call('/api/health');
      assert.equal(health.json.payments, 'unavailable');
      const pix = await call('/api/payments/pix', { method: 'POST', body: { productId: 'ayla_monthly', checkoutToken: token() } });
      assert.equal(pix.status, 503, 'checkout falha claramente');
      assert.equal((await db.get('SELECT count(*) AS n FROM orders')).n, 0, 'nenhum pedido criado');
      assert.ok(!Object.keys(require.cache).some(k => /mock-provider/.test(k)), 'mock nunca carregado');
      assert.equal(syncpayCalls.length, 0);
      console.log(`PASS produção Ayla (${scenario}): GET / 200, favicon, login, redefinir-senha, criadora/login, catálogo; checkout 503 sem pedido; mock nunca carregado`);
      return;
    }

    // ---------------------------------------------------------------- SyncPay
    assert.equal((await call('/api/health')).json.payments, 'ok');
    const created = {};
    for (const [id, price] of [['ayla_monthly', 9.9], ['ayla_quarterly', 19.9], ['ayla_semester', 29.9], ['ayla_whatsapp_unlock', 7.9]]) {
      const before = syncpayCalls.length;
      const checkoutToken = token();
      const r = await call('/api/payments/pix', { method: 'POST', body: { productId: id, checkoutToken, price: 0.01, amount: 0.01, total: 0.01 } });
      assert.equal(r.status, 201, id + ' ' + r.text);
      assert.equal(r.json.product.price, price, id + ' preço do backend');
      assert.ok(r.json.pix.copyPaste && r.json.pix.qrCode, id + ' PIX e QR');
      assert.equal(r.json.mock, false);
      const cash = syncpayCalls.slice(before).find(c => c.kind === 'cash-in');
      assert.deepEqual(cash.body, { amount: price }, id + ': SyncPay recebe só o valor do catálogo');
      created[id] = await db.get('SELECT * FROM orders WHERE public_id=?', r.json.orderId);
      created[id].checkoutToken = checkoutToken;
      assert.equal(r.json.accountFlow, true, 'pós-pagamento cria conta BUYER');
      assert.equal(created[id].payment_provider, 'syncpay');
      assert.equal(Number(created[id].amount), price);
      assert.equal(created[id].status, 'PENDING');
    }
    assert.equal(syncpayCalls.filter(c => c.kind === 'auth').length, 1, 'token SyncPay reaproveitado');

    // Mimo: mínimo R$ 5 validado no backend; valor vem de tipAmountCents, não de price/amount.
    assert.equal((await call('/api/payments/pix', { method: 'POST', body: { productId: 'ayla_tip', checkoutToken: token(), tipAmountCents: 499 } })).status, 400);
    const tip = await call('/api/payments/pix', { method: 'POST', body: { productId: 'ayla_tip', checkoutToken: token(), tipAmountCents: 1500, price: 1, amount: 1 } });
    assert.equal(tip.status, 201, tip.text);
    assert.equal(tip.json.product.price, 15);
    assert.deepEqual(syncpayCalls.at(-1).body, { amount: 15 });

    // Produtos que não são da Ayla.
    for (const id of ['monthly', 'quarterly', 'semester', 'whatsapp_unlock', 'joice_tip', 'joice_monthly']) {
      assert.equal((await call('/api/payments/pix', { method: 'POST', body: { productId: id, checkoutToken: token() } })).status, 404, id);
    }

    // Webhook.
    const hook = async (payload, { sign = true, event = payload.event } = {}) => {
      const raw = JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(t + '.').update(raw).digest('hex');
      const headers = { 'X-SyncPay-Event': event, 'X-SyncPay-Delivery': crypto.randomUUID() };
      if (sign) headers['X-SyncPay-Signature'] = `t=${t},v1=${v1}`;
      return call('/api/webhooks/syncpay', { method: 'POST', raw, headers });
    };
    const tx = (order, extra = {}) => ({ event_id: crypto.randomUUID(), event: 'transaction.updated',
      transaction: { reference_id: order.provider_payment_id, amount: Number(order.amount), currency: 'BRL', payment_method: 'pix', status: 'completed', ...extra } });
    const monthly = created.ayla_monthly, whats = created.ayla_whatsapp_unlock;

    assert.equal((await hook(tx(monthly), { sign: false })).status, 401, 'sem assinatura');
    const pending = await hook({ ...tx(monthly), event: 'transaction.created' });
    assert.equal(pending.status, 200); assert.equal(pending.json.ignored, true);
    assert.equal((await hook(tx(monthly, { amount: 0.01 }))).status, 409, 'valor divergente');
    // Conta SyncPay compartilhada com a outra criadora: evento válido de uma
    // transação que não é desta casa é reconhecido e ignorado, sem 404 em série.
    const estrangeira = await hook(tx({ provider_payment_id: 'sp_da_outra_criadora', amount: 9.9 }));
    assert.equal(estrangeira.status, 200, 'transação de outra criadora');
    assert.equal(estrangeira.json.ignored, true);
    assert.equal(estrangeira.json.reason, 'outra criadora');
    // Cobrança nascendo agora: o identifier pode ser desta casa e ainda não
    // ter sido gravado, então a reentrega continua sendo pedida.
    await db.run("INSERT INTO orders(public_id,product_id,amount,status,payment_provider,checkout_hash,creation_phase) VALUES (?,?,?,?,?,?,?)",
      'ord-nascendo', 'ayla_monthly', 9.9, 'CREATING', 'syncpay', crypto.randomBytes(32).toString('hex'), 'ready');
    assert.equal((await hook(tx({ provider_payment_id: 'sp_talvez_nossa', amount: 9.9 }))).status, 404, 'cobrança em criação pede reentrega');
    await db.run("DELETE FROM orders WHERE public_id='ord-nascendo'");
    assert.equal((await db.get('SELECT count(*) AS n FROM entitlements')).n, 0, 'nada liberado antes do pagamento válido');

    for (let i = 0; i < 3; i++) assert.equal((await hook(tx(monthly))).status, 200, 'pago (reentrega ' + i + ')');
    assert.equal((await db.get('SELECT status FROM orders WHERE id=?', monthly.id)).status, 'PAID');
    assert.equal((await db.get('SELECT count(*) AS n FROM entitlements WHERE order_id=?', monthly.id)).n, 0, 'acesso só depois de criar a conta');
    // "Pagamento confirmado" -> criação de acesso -> BUYER -> vincular order -> entitlement.
    const accounts = require('../services/buyer-accounts');
    const buyerId = crypto.randomUUID();
    await db.run("INSERT INTO buyer_accounts(user_id,email,role) VALUES (?,?,'BUYER')", buyerId, 'compradora@example.com');
    await assert.rejects(accounts.claim(buyerId, monthly.public_id, token()), /Compra/);
    await accounts.claim(buyerId, monthly.public_id, monthly.checkoutToken);
    await accounts.claim(buyerId, monthly.public_id, monthly.checkoutToken); // repetir não duplica
    assert.equal((await hook(tx(monthly))).status, 200, 'reentrega após o vínculo');
    const grants = await db.all('SELECT * FROM entitlements WHERE order_id=?', monthly.id);
    assert.equal(grants.length, 1, 'idempotente: um entitlement');
    assert.equal(grants[0].product_id, 'ayla_monthly');
    assert.equal(grants[0].grant_type, 'subscription');
    const expires = grants[0].expires_at instanceof Date ? grants[0].expires_at : new Date(String(grants[0].expires_at).replace(' ', 'T') + 'Z');
    const paidAt = (await db.get('SELECT paid_at FROM orders WHERE id=?', monthly.id)).paid_at;
    const paid = paidAt instanceof Date ? paidAt : new Date(String(paidAt).replace(' ', 'T') + 'Z');
    const days = (expires - paid) / 86400000;
    assert.ok(days > 29.9 && days <= 30.01, '30 dias');

    assert.equal((await hook(tx(whats))).status, 200);
    await accounts.claim(buyerId, whats.public_id, whats.checkoutToken);
    const contact = await db.get('SELECT * FROM entitlements WHERE order_id=?', whats.id);
    assert.equal(contact.grant_type, 'contact');
    assert.equal(contact.expires_at, null);
    const ent = require('../services/entitlements');
    assert.equal(await ent.activeSubscription(await db.get('SELECT * FROM orders WHERE id=?', whats.id)), null, 'WhatsApp não libera VIP');
    assert.ok(await ent.activeSubscription(await db.get('SELECT * FROM orders WHERE id=?', monthly.id)), 'VIP ativo');
    assert.equal((await db.get("SELECT count(*) AS n FROM entitlements WHERE order_id=? AND grant_type='contact'", monthly.id)).n, 0, 'VIP não libera WhatsApp');

    assert.equal((await db.get("SELECT count(*) AS n FROM entitlements WHERE product_id NOT LIKE 'ayla\\_%'")).n, 0, 'nenhum entitlement fora da Ayla');
    assert.equal((await db.get("SELECT count(*) AS n FROM orders WHERE product_id NOT LIKE 'ayla\\_%'")).n, 0, 'nenhum pedido fora da Ayla');
    assert.equal((await db.get("SELECT count(*) AS n FROM entitlements WHERE product_id LIKE '%joice%'")).n, 0);

    if (pre) {
      const rls = await pre.query("SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ayla' AND c.relname IN ('orders','entitlements','access_tokens','entitlement_duplicates_archive')");
      assert.equal(rls.rows.length, 4);
      assert.ok(rls.rows.every(r => r.relrowsecurity), 'RLS ligado nas 4 tabelas');
      const ok = await pre.query("SELECT has_table_privilege('anon','ayla.orders','SELECT') AS o, has_table_privilege('anon','ayla.entitlements','SELECT') AS e");
      assert.equal(ok.rows[0].o, false); assert.equal(ok.rows[0].e, false);
      const tables = await pre.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
      assert.equal(tables.rows[0].n, 0, 'nada em public');
    }
    console.log('PASS produção Ayla (syncpay): 1m/3m/6m/WhatsApp/mimo com preço só do backend, PIX + QR, produtos não-Ayla 404, '
      + 'webhook assinado (401/ignorado/409/404/PAID), idempotência, entitlements só Ayla, WhatsApp e VIP separados'
      + (pre ? ', RLS em PostgreSQL real com dono não-superusuário, anon sem acesso' : ''));
  } finally {
    server.close();
    await require('../db/database').closeDb().catch(() => {});
    if (pre) await pre.end();
    if (engine) await engine.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
