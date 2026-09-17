// Script de ativação da SyncPay na Ayla, com SyncPay, Vercel e site simulados.
// Nenhuma chamada externa, nenhuma credencial real, nenhuma cobrança.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const script = require('../scripts/ativar-syncpay-ayla');
const base = require('../scripts/configurar-ayla');

const CLIENT_ID = 'ci_teste';
const CLIENT_SECRET = 'cs_' + crypto.randomBytes(12).toString('hex');
const PREVIEW = 'https://privacy-ayla-preview123.vercel.app';
const PRODUCTION = script.ORIGIN;
const JOICE_WEBHOOK = { id: 13597, url: 'https://privacy-joice.vercel.app/api/webhooks/syncpay', event: 'transaction', trigger_all_products: true };

assert.deepEqual(script.parseEnvFile('# c\nSYNCPAY_CLIENT_ID=abc\nSYNCPAY_CLIENT_SECRET="s e c"\nexport OUTRA=1\nlixo\n'),
  { SYNCPAY_CLIENT_ID: 'abc', SYNCPAY_CLIENT_SECRET: 's e c', OUTRA: '1' });

function fakeWorld({ previewProtected = true, productionMock = false, existingWebhook = null } = {}) {
  const state = {
    webhooks: existingWebhook ? [JOICE_WEBHOOK, existingWebhook] : [JOICE_WEBHOOK],
    token: null, envs: [], deploys: [], pix: [], webhookCalls: [], curl: 0, deleted: []
  };
  const reply = (status, body) => ({ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body ?? '') });
  const asResponse = r => new Response(r.bodyText, { status: r.status });

  function site(url, route, init) {
    const staging = url === PREVIEW ? true : productionMock;
    if (route === '/api/health') return reply(200, { status: 'ok', payments: 'ok' });
    if (route === '/api/catalog') return reply(200, { mock: staging, products: [
      { id: 'ayla_tip', price: 5 }, { id: 'ayla_whatsapp_unlock', price: 7.9 },
      { id: 'ayla_monthly', price: 9.9 }, { id: 'ayla_quarterly', price: 19.9 }, { id: 'ayla_semester', price: 29.9 }] });
    if (route === '/api/payments/pix') {
      const body = JSON.parse(init.body);
      state.pix.push({ url, productId: body.productId });
      assert.ok(!('tipAmountCents' in body));
      return reply(201, { orderId: 'ord_' + state.pix.length, status: 'PENDING', product: { id: body.productId, price: 9.9 }, pix: { copyPaste: 'PIXSECRETO', qrCode: 'data:image/png;base64,AA' }, mock: staging });
    }
    if (route === '/api/webhooks/syncpay') {
      const signature = init.headers['X-SyncPay-Signature'];
      state.webhookCalls.push({ url, signed: Boolean(signature) });
      if (!signature) return reply(401, { error: 'Assinatura inválida.' });
      const created = state.webhooks.find(w => w.url === script.WEBHOOK_URL);
      const [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
      const expected = crypto.createHmac('sha256', created.token).update(t + '.').update(Buffer.from(init.body)).digest('hex');
      assert.equal(v1, expected, 'assinatura do webhook confere com o token cadastrado');
      return reply(200, { received: true, ignored: true });
    }
    return reply(200, '<html>ok</html>');
  }

  async function fetchImpl(target, init = {}) {
    const url = new URL(target);
    const origin = url.origin;
    const route = url.pathname + url.search;
    if (origin === 'https://api.syncpayments.com.br') {
      const token = (init.headers.Authorization || '').replace('Bearer ', '');
      if (route === '/api/partner/v1/auth-token') {
        const body = JSON.parse(init.body);
        if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return asResponse(reply(401, {}));
        state.token = 'tok_' + crypto.randomBytes(4).toString('hex');
        return asResponse(reply(200, { access_token: state.token, expires_in: 3600 }));
      }
      assert.equal(token, state.token, 'chamadas da SyncPay usam o token');
      if (route.startsWith('/api/partner/v1/webhooks?')) return asResponse(reply(200, { data: state.webhooks.map(({ token: _t, ...w }) => w), meta: { has_more_pages: false } }));
      if (route === '/api/partner/v1/webhooks' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        assert.deepEqual(body, { title: 'privacy-ayla', url: script.WEBHOOK_URL, event: 'transaction', trigger_all_products: true });
        const hook = { id: 5000 + state.webhooks.length, ...body, token: crypto.randomBytes(16).toString('hex') };
        state.webhooks.push(hook);
        return asResponse(reply(201, hook));
      }
      const remove = /^\/api\/partner\/v1\/webhooks\/(\d+)$/.exec(route);
      if (remove && init.method === 'DELETE') {
        const id = Number(remove[1]);
        assert.notEqual(id, JOICE_WEBHOOK.id, 'nunca mexe no webhook da Joice');
        state.deleted.push(id);
        state.webhooks = state.webhooks.filter(w => w.id !== id);
        return asResponse(reply(200, { message: 'Webhook deleted successfully.' }));
      }
      return asResponse(reply(404, {}));
    }
    if (origin === PREVIEW && previewProtected) return asResponse(reply(401, 'Authentication Required'));
    if (origin === PREVIEW || origin === PRODUCTION) return asResponse(site(origin, url.pathname, init));
    throw new Error('rede não simulada: ' + target);
  }

  const vercel = (args, { input } = {}) => {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const [cmd] = args;
    if (cmd === 'whoami') return ok('conta-teste\n');
    if (cmd === 'api') {
      const endpoint = args[1];
      const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
      if (method === 'GET') return ok(JSON.stringify({ envs: state.envs.map(({ value, ...e }) => e) }));
      if (method === 'POST') { state.envs.push({ id: 'env_' + state.envs.length, ...JSON.parse(input) }); return ok(''); }
      if (method === 'DELETE') { const id = endpoint.split('/').pop().split('?')[0]; state.envs = state.envs.filter(e => e.id !== id); return ok(''); }
    }
    if (cmd === 'deploy') {
      const prod = args.includes('--prod');
      state.deploys.push(prod ? 'production' : 'preview');
      return ok((prod ? 'https://privacy-ayla-prod999.vercel.app' : PREVIEW) + '\n');
    }
    return { status: 1, stdout: '', stderr: 'inesperado ' + args.join(' ') };
  };
  return { state, fetch: fetchImpl, vercel, site };
}

// `vercel curl` passa pela proteção do Preview: responde direto pelo site simulado.
function withCurl(world) {
  const original = world.vercel;
  return (args, options) => {
    if (args[0] !== 'curl') return original(args, options);
    world.state.curl += 1;
    const route = args[1], url = args[args.indexOf('--deployment') + 1];
    const flags = args.slice(args.indexOf('--') + 1);
    const out = flags[flags.indexOf('-o') + 1], head = flags[flags.indexOf('-D') + 1];
    const method = flags.includes('-X') ? flags[flags.indexOf('-X') + 1] : 'GET';
    const dataFile = flags.includes('--data-binary') ? flags[flags.indexOf('--data-binary') + 1].slice(1) : null;
    const headers = {};
    for (let i = 0; i < flags.length; i++) if (flags[i] === '-H') { const [k, ...v] = flags[i + 1].split(': '); headers[k] = v.join(': '); }
    const body = dataFile ? fs.readFileSync(dataFile, 'utf8') : undefined;
    const response = world.site(url, route, { method, body, headers });
    const text = response.bodyText;
    fs.writeFileSync(head, `HTTP/2 ${response.status}\r\n\r\n`);
    fs.writeFileSync(out, text);
    return { status: 0, stdout: '', stderr: '' };
  };
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ayla-syncpay-'));
  const root = path.join(workspace, 'Privacy_Ayla');
  fs.mkdirSync(path.join(root, '.vercel'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_a', orgId: 'team_a', projectName: 'privacy-ayla' }));
  fs.writeFileSync(path.join(root, 'backend', 'tests', 'check.js'), 'process.exit(0)');
  // "projeto da Joice" ao lado, somente leitura
  const joice = path.join(workspace, 'Privacy_Joice');
  fs.mkdirSync(path.join(joice, 'backend'), { recursive: true });
  const joiceEnv = path.join(joice, 'backend', '.env');
  fs.writeFileSync(joiceEnv, `PAYMENT_PROVIDER=syncpay\nSYNCPAY_CLIENT_ID=${CLIENT_ID}\nSYNCPAY_CLIENT_SECRET=${CLIENT_SECRET}\nSYNCPAY_WEBHOOK_SECRET=segredo-da-joice\n`);
  const joiceBefore = fs.readFileSync(joiceEnv, 'utf8');

  const run = async (deps) => {
    const lines = [];
    const original = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { return { report: await script.main(deps), out: lines.join('\n') }; } finally { console.log = original; }
  };

  try {
    // ------------------------------------------------------- caminho completo
    const world = fakeWorld();
    world.vercel = withCurl(world);
    const first = await run({ root, fetch: world.fetch, vercel: world.vercel,
      ask: async q => { throw new Error('não deveria perguntar: ' + q); } });
    const envs = new Map(world.state.envs.map(e => [`${e.key}:${[].concat(e.target).sort().join('+')}`, e]));
    assert.equal(envs.get('PAYMENT_PROVIDER:production').value, 'syncpay');
    assert.equal(envs.get('PAYMENT_PROVIDER:preview').value, 'staging');
    assert.equal(envs.get('APP_ENV:production').value, 'production');
    assert.equal(envs.get('APP_ENV:preview').value, 'staging');
    assert.equal(envs.get('NODE_ENV:production').value, 'production');
    for (const key of ['PUBLIC_APP_URL', 'FRONTEND_URL', 'ADMIN_ORIGIN']) {
      assert.equal(envs.get(key + ':production').value, PRODUCTION, key);
      assert.ok(!/joice/i.test(envs.get(key + ':production').value));
    }
    assert.equal(envs.get('SYNCPAY_CLIENT_ID:production').type, 'sensitive');
    assert.equal(envs.get('SYNCPAY_CLIENT_SECRET:production').type, 'sensitive');
    assert.equal(envs.get('SYNCPAY_WEBHOOK_SECRET:production').type, 'sensitive');
    assert.equal(envs.get('SYNCPAY_CLIENT_SECRET:production').value, CLIENT_SECRET);
    assert.ok(!envs.has('SYNCPAY_CLIENT_SECRET:preview'), 'Preview não recebe credencial real');
    assert.equal(envs.get('STAGING_DATABASE_SCHEMA:preview').value, 'staging_ayla_preview');

    const ayla = world.state.webhooks.find(w => w.url === script.WEBHOOK_URL);
    assert.ok(ayla && ayla.token, 'webhook da Ayla criado com token próprio');
    assert.notEqual(ayla.token, 'segredo-da-joice');
    assert.equal(envs.get('SYNCPAY_WEBHOOK_SECRET:production').value, ayla.token);
    assert.equal(envs.get('SYNCPAY_WEBHOOK_ID:production').value, String(ayla.id));
    assert.ok(world.state.webhooks.some(w => w.id === JOICE_WEBHOOK.id), 'webhook da Joice intacto');
    assert.deepEqual(world.state.deleted, []);
    assert.deepEqual(world.state.deploys, ['preview', 'production'], 'Preview antes da Production');
    assert.equal(world.state.pix.length, 2, 'um PIX no Preview, um na Production');
    assert.ok(world.state.pix.every(p => p.productId === 'ayla_monthly'));
    assert.ok(world.state.curl > 0, 'Preview protegido testado via vercel curl');
    assert.deepEqual(world.state.webhookCalls.map(c => c.signed), [false, true]);
    assert.equal(first.report.production.url, PRODUCTION);
    assert.equal(fs.readFileSync(joiceEnv, 'utf8'), joiceBefore, 'arquivo da Joice não foi alterado');

    const saved = fs.readFileSync(path.join(root, '.audit', 'syncpay-ayla.json'), 'utf8');
    for (const secret of [CLIENT_SECRET, CLIENT_ID, ayla.token, world.state.token, 'PIXSECRETO', 'segredo-da-joice']) {
      assert.ok(!first.out.includes(secret), 'segredo na tela: ' + secret.slice(0, 6));
      assert.ok(!saved.includes(secret), 'segredo no relatório');
    }
    assert.ok(!/privacy-joice/.test(saved));

    // ------------------------------- Production que responde simulada: recusa
    const fake = fakeWorld({ productionMock: true });
    fake.vercel = withCurl(fake);
    await assert.rejects(run({ root, fetch: fake.fetch, vercel: fake.vercel, ask: async () => '' }), /simulado=true em Production/);
    assert.deepEqual(fake.state.deploys, ['preview', 'production']);

    // --------------------- webhook já cadastrado + segredo guardado: mantém
    const keep = fakeWorld({ existingWebhook: { id: 777, url: script.WEBHOOK_URL, event: 'transaction', trigger_all_products: true, token: 'antigo' } });
    keep.vercel = withCurl(keep);
    keep.state.envs.push({ id: 'env_x', key: 'SYNCPAY_WEBHOOK_SECRET', target: ['production'], type: 'sensitive', value: 'antigo' });
    const second = await run({ root, fetch: keep.fetch, vercel: keep.vercel, ask: async () => '' });
    assert.equal(second.report.webhook.acao, 'mantido');
    assert.deepEqual(keep.state.deleted, [], 'webhook existente preservado');
    assert.equal(keep.state.webhooks.filter(w => w.url === script.WEBHOOK_URL).length, 1, 'sem webhook duplicado');
    assert.ok(!keep.state.envs.some(e => e.key === 'SYNCPAY_WEBHOOK_SECRET' && e.value !== 'antigo'), 'segredo do webhook preservado');

    // ------------------- pasta ligada a outro projeto: recusa sem publicar
    const outro = fakeWorld();
    outro.vercel = withCurl(outro);
    fs.writeFileSync(path.join(root, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_b', orgId: 'team_a', projectName: 'privacy-joice' }));
    await assert.rejects(run({ root, fetch: outro.fetch, vercel: outro.vercel, ask: async () => '' }), /privacy-ayla/);
    assert.deepEqual(outro.state.deploys, []);

    console.log('PASS ativar-syncpay-ayla: credenciais lidas sem alterar a Joice, webhook próprio da Ayla (Joice intacto), '
      + 'ENV Production=syncpay e Preview=staging, Preview testado antes da Production, PIX sem pagamento, '
      + 'webhook 401 sem assinatura e 200 ignorado assinado, segredos nunca exibidos, projeto errado bloqueado');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
