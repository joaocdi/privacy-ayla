'use strict';
/**
 * ATIVAR SYNCPAY NA AYLA — webhook próprio, variáveis, Preview e Production.
 *
 * Rode no SEU computador, na pasta E:\Privacy_Ayla:
 *     ativar_syncpay_ayla.bat     (ou: node backend/scripts/ativar-syncpay-ayla.js)
 *
 * O que faz, nesta ordem:
 *   1. confere que a pasta está ligada ao projeto Vercel privacy-ayla;
 *   2. lê SOMENTE SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET do projeto da Joice
 *      (leitura pura; nada é escrito lá) ou pergunta, se não achar;
 *   3. autentica na SyncPay para conferir as credenciais;
 *   4. cadastra o webhook PRÓPRIO da Ayla (a SyncPay não aceita URL por
 *      transação: cada projeto precisa do seu webhook e do seu segredo);
 *   5. grava as variáveis na Vercel — Production com syncpay, Preview com
 *      pagamento simulado;
 *   6. publica o Preview e testa;
 *   7. só então publica a Production e testa (inclui um PIX real NÃO PAGO).
 *
 * Nunca imprime credencial, token, segredo ou código PIX.
 * Nunca toca em E:\Privacy_Joice (só leitura) nem no projeto privacy-joice.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = require('./configurar-ayla');

const { scrub, remember, say, ok, warn, step, fail, readLink, realVercel, applyEnv, listEnv, envEndpoint, makePrompter, PROJECT } = base;
const ROOT = path.resolve(__dirname, '..', '..');
const SYNCPAY = 'https://api.syncpayments.com.br/api/partner/v1';
const ORIGIN = base.PRODUCTION_ORIGIN;              // https://privacy-ayla.vercel.app
const WEBHOOK_URL = ORIGIN + '/api/webhooks/syncpay';
const SOURCES = [                                    // só leitura, na ordem
  ['..', 'Privacy_Joice', 'backend', '.env'],
  ['..', 'Privacy_Joice', '.env.local'],
  ['..', 'Privacy_Joice', '.env.vercel-check'],
  ['..', 'Privacy_Joice', 'backend.env']
];

/* ------------------------------------------------------------- credenciais */

function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

async function readCredentials(ask, root = ROOT) {
  for (const parts of SOURCES) {
    const file = path.resolve(root, ...parts);
    if (!fs.existsSync(file)) continue;
    const values = parseEnvFile(fs.readFileSync(file, 'utf8'));
    const clientId = (values.SYNCPAY_CLIENT_ID || '').trim();
    const clientSecret = (values.SYNCPAY_CLIENT_SECRET || '').trim();
    if (clientId && clientSecret) {
      remember(clientSecret, clientId);
      ok('credenciais SyncPay lidas de ' + path.relative(path.resolve(root, '..'), file) + ' (somente leitura)');
      return { clientId, clientSecret, source: parts.join('/') };
    }
  }
  warn('não encontrei as credenciais SyncPay nos arquivos da Joice.');
  say('  Elas estão no painel da SyncPay (Integrações / API) ou nas variáveis do projeto privacy-joice na Vercel.');
  const clientId = await ask('  SYNCPAY_CLIENT_ID: ', { hidden: true });
  const clientSecret = await ask('  SYNCPAY_CLIENT_SECRET: ', { hidden: true });
  if (!clientId || !clientSecret) throw fail('Sem as credenciais não dá para seguir.');
  remember(clientSecret, clientId);
  return { clientId, clientSecret, source: 'digitadas' };
}

/* ---------------------------------------------------------------- syncpay */

async function syncpay(deps, route, { method = 'GET', token, body } = {}) {
  const response = await deps.fetch(SYNCPAY + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* resposta não-JSON */ }
  return { status: response.status, ok: response.ok, json };
}

async function authenticate(deps, credentials) {
  const auth = await syncpay(deps, '/auth-token', { method: 'POST', body: { client_id: credentials.clientId, client_secret: credentials.clientSecret } });
  if (!auth.ok || !auth.json || typeof auth.json.access_token !== 'string') throw fail(`SyncPay recusou as credenciais (HTTP ${auth.status}).`);
  remember(auth.json.access_token);
  ok('credenciais SyncPay aceitas (conta compartilhada com a Joice, como você pediu)');
  return auth.json.access_token;
}

/** A SyncPay não tem URL por transação: cada projeto precisa do seu webhook. */
async function ensureWebhook(deps, token, { keepExisting }) {
  const list = await syncpay(deps, '/webhooks?per_page=100', { token });
  if (!list.ok) throw fail(`Não consegui listar os webhooks da SyncPay (HTTP ${list.status}).`);
  const all = Array.isArray(list.json) ? list.json : (list.json?.data || []);
  const mine = all.filter(w => String(w.url || '').replace(/\/+$/, '') === WEBHOOK_URL);
  const foreign = all.filter(w => !mine.includes(w)).length;
  say(`  Webhooks na conta: ${all.length} (${foreign} de outros projetos, preservados).`);

  if (mine.length && keepExisting) {
    ok(`webhook da Ayla já cadastrado (id ${mine[0].id}); segredo atual mantido`);
    return { id: mine[0].id, secret: null, action: 'mantido' };
  }
  for (const old of mine) {
    // O token do webhook só aparece na criação: sem ele guardado, recriamos o da Ayla.
    const removed = await syncpay(deps, '/webhooks/' + old.id, { method: 'DELETE', token });
    if (!removed.ok) throw fail(`Não consegui substituir o webhook antigo da Ayla (HTTP ${removed.status}).`);
    warn(`webhook antigo da Ayla removido (id ${old.id}) para gerar um segredo novo`);
  }
  const created = await syncpay(deps, '/webhooks', {
    method: 'POST', token,
    body: { title: 'privacy-ayla', url: WEBHOOK_URL, event: 'transaction', trigger_all_products: true }
  });
  const data = created.json?.data || created.json;
  if (!created.ok || !data || !data.id || typeof data.token !== 'string' || !data.token) {
    throw fail(`A SyncPay não devolveu o webhook cadastrado (HTTP ${created.status}).`);
  }
  remember(data.token);
  ok(`webhook da Ayla cadastrado: id ${data.id}, evento transaction, ${WEBHOOK_URL}`);
  return { id: String(data.id), secret: data.token, action: mine.length ? 'recriado' : 'criado' };
}

/* ----------------------------------------------------------------- vercel */

function envPlan({ credentials, webhook }) {
  const production = ['production'];
  const plan = [
    { key: 'PAYMENT_PROVIDER', value: 'syncpay', target: production, type: 'encrypted' },
    { key: 'APP_ENV', value: 'production', target: production, type: 'encrypted' },
    { key: 'NODE_ENV', value: 'production', target: production, type: 'encrypted' },
    { key: 'PUBLIC_APP_URL', value: ORIGIN, target: production, type: 'encrypted' },
    { key: 'FRONTEND_URL', value: ORIGIN, target: production, type: 'encrypted' },
    { key: 'ADMIN_ORIGIN', value: ORIGIN, target: production, type: 'encrypted' },
    { key: 'SYNCPAY_CLIENT_ID', value: credentials.clientId, target: production, type: 'sensitive' },
    { key: 'SYNCPAY_CLIENT_SECRET', value: credentials.clientSecret, target: production, type: 'sensitive' },
    { key: 'SYNCPAY_WEBHOOK_ID', value: String(webhook.id), target: production, type: 'encrypted' },
    // Preview continua com pagamento simulado: nenhuma cobrança real em teste.
    { key: 'PAYMENT_PROVIDER', value: 'staging', target: ['preview'], type: 'encrypted' },
    { key: 'APP_ENV', value: 'staging', target: ['preview'], type: 'encrypted' },
    { key: 'STAGING_DATABASE_SCHEMA', value: base.SCHEMAS.preview, target: ['preview'], type: 'encrypted' }
  ];
  if (webhook.secret) plan.push({ key: 'SYNCPAY_WEBHOOK_SECRET', value: webhook.secret, target: production, type: 'sensitive' });
  return plan;
}

function hasProductionWebhookSecret(deps, link) {
  return listEnv(deps, link).some(e => e.key === 'SYNCPAY_WEBHOOK_SECRET' && e.target.includes('production'));
}

/* ------------------------------------------------------------------ testes */

/** GET/POST numa URL publicada. Preview protegido passa pelo `vercel curl`. */
async function probe(deps, url, route, { method = 'GET', body, headers = {} } = {}) {
  const direct = await deps.fetch(url + route, {
    method, redirect: 'manual', signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  }).catch(error => ({ failed: error }));
  // Só o Preview pode estar protegido pela Vercel; na Production um 401 é resposta do app.
  const protectedPreview = url !== ORIGIN;
  if (!direct.failed && (direct.status !== 401 || !protectedPreview)) {
    const text = await direct.text();
    return { status: direct.status, text, json: safeJson(text) };
  }
  if (direct.failed && !protectedPreview) throw fail(`Não consegui acessar ${url}${route}: ${direct.failed.message}`);
  // Proteção de Preview da Vercel: o CLI sabe passar por ela.
  const out = path.join(os.tmpdir(), 'ayla-probe-' + crypto.randomBytes(4).toString('hex'));
  const args = ['curl', route, '--deployment', url, '--yes', '--', '-s', '-o', out + '.body', '-D', out + '.head', '-X', method];
  if (body !== undefined) {
    fs.writeFileSync(out + '.req', typeof body === 'string' ? body : JSON.stringify(body));
    args.push('--data-binary', '@' + out + '.req', '-H', 'Content-Type: application/json');
  }
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
  const result = deps.vercel(args);
  try {
    const head = fs.existsSync(out + '.head') ? fs.readFileSync(out + '.head', 'utf8') : '';
    const status = Number((/^HTTP\/[\d.]+ (\d{3})/m.exec(head) || [])[1]);
    const text = fs.existsSync(out + '.body') ? fs.readFileSync(out + '.body', 'utf8') : '';
    if (!status) throw fail('Não consegui testar a URL protegida do Preview: ' + scrub((result.stderr || result.stdout || '').trim().split(/\r?\n/).pop() || ''));
    return { status, text, json: safeJson(text) };
  } finally {
    for (const suffix of ['.body', '.head', '.req']) fs.rmSync(out + suffix, { force: true });
  }
}
function safeJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }

const PAGES = ['/', '/favicon.ico', '/login', '/meu-acesso', '/esqueci-senha', '/redefinir-senha', '/criadora/login', '/vip'];

async function smoke(deps, url, { staging }) {
  const results = {};
  for (const route of PAGES) {
    const r = await probe(deps, url, route);
    results[route] = r.status;
    const good = route === '/favicon.ico' ? r.status < 500 : [200, 303].includes(r.status);
    if (!good) throw fail(`${url}${route} respondeu ${r.status}.`);
  }
  ok('páginas OK: ' + Object.entries(results).map(([r, s]) => `${r} ${s}`).join(', '));

  const health = await probe(deps, url, '/api/health');
  if (health.json?.status !== 'ok') throw fail('/api/health não respondeu ok.');
  if (health.json.payments !== 'ok') throw fail('/api/health diz que o pagamento está indisponível.');
  ok('/api/health: site e pagamento configurados');

  const catalog = await probe(deps, url, '/api/catalog');
  const prices = Object.fromEntries((catalog.json?.products || []).map(p => [p.id, p.price]));
  const expected = { ayla_tip: 5, ayla_whatsapp_unlock: 7.9, ayla_monthly: 9.9, ayla_quarterly: 19.9, ayla_semester: 29.9 };
  for (const [id, price] of Object.entries(expected)) {
    if (prices[id] !== price) throw fail(`catálogo: ${id} veio ${prices[id]}, esperado ${price}.`);
  }
  if (catalog.json.mock !== Boolean(staging)) throw fail(`catálogo: pagamento simulado=${catalog.json.mock} em ${staging ? 'Preview' : 'Production'}.`);
  ok(`catálogo: 9,90 / 19,90 / 29,90 / WhatsApp 7,90 / mimo 5,00 — simulado: ${catalog.json.mock}`);
  results.catalog = prices;
  return results;
}

/** Cria UM PIX de verdade e não paga nada. O código PIX nunca é impresso. */
async function pixCheck(deps, url, { productId = 'ayla_monthly', price = 9.9 } = {}) {
  const r = await probe(deps, url, '/api/payments/pix', {
    method: 'POST',
    body: { productId, checkoutToken: crypto.randomBytes(32).toString('hex'), price: 0.01, amount: 0.01 }
  });
  if (r.status !== 201 || !r.json?.pix?.copyPaste) throw fail(`checkout ${productId} respondeu ${r.status}.`);
  if (r.json.product.price !== price) throw fail(`checkout ${productId}: preço ${r.json.product.price} (o valor do navegador não pode mandar).`);
  ok(`checkout ${productId}: PIX gerado (R$ ${price.toFixed(2).replace('.', ',')}), pedido ${r.json.orderId}, NÃO pago`);
  return { orderId: r.json.orderId, price: r.json.product.price, simulado: r.json.mock === true };
}

/** Webhook: sem assinatura recusa; assinado e não pago é reconhecido sem liberar acesso. */
async function webhookCheck(deps, url, secret) {
  const payload = { event_id: crypto.randomUUID(), event: 'transaction.created',
    transaction: { reference_id: 'teste-' + crypto.randomUUID(), amount: 9.9, currency: 'BRL', payment_method: 'pix', status: 'pending' } };
  const raw = JSON.stringify(payload);
  const headers = { 'X-SyncPay-Event': payload.event, 'X-SyncPay-Delivery': crypto.randomUUID() };
  const semAssinatura = await probe(deps, url, '/api/webhooks/syncpay', { method: 'POST', body: raw, headers });
  if (semAssinatura.status === 503) throw fail('webhook sem SYNCPAY_WEBHOOK_SECRET na Production.');
  if (semAssinatura.status !== 401) throw fail(`webhook sem assinatura respondeu ${semAssinatura.status} (esperado 401).`);

  if (!secret) return { semAssinatura: 401, assinado: 'não testado (segredo mantido do cadastro anterior)' };
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(t + '.').update(Buffer.from(raw)).digest('hex');
  const assinado = await probe(deps, url, '/api/webhooks/syncpay', { method: 'POST', body: raw, headers: { ...headers, 'X-SyncPay-Signature': `t=${t},v1=${v1}` } });
  if (assinado.status !== 200 || assinado.json?.ignored !== true) throw fail(`webhook assinado (evento não pago) respondeu ${assinado.status}.`);
  ok('webhook: sem assinatura 401; assinado e não pago 200 ignorado (nenhum acesso liberado)');
  return { semAssinatura: 401, assinado: '200 ignorado' };
}

/* ------------------------------------------------------------ orquestração */

async function main(deps = {}) {
  deps = { fetch: globalThis.fetch, vercel: realVercel, root: ROOT, ...deps };
  const ask = deps.ask || makePrompter();
  const report = { quando: new Date().toISOString() };

  say('==================================================');
  say('  ATIVAR SYNCPAY NA AYLA  (' + PROJECT + ')');
  say('==================================================');

  step('1. Projeto Vercel');
  const link = readLink(deps.root);
  if (!link || link.projectName !== PROJECT) throw fail(`Esta pasta não está ligada ao projeto ${PROJECT}. Rode antes o configurar_ayla.bat.`);
  const who = deps.vercel(['whoami']);
  const account = (who.stdout || '').trim().split(/\r?\n/).pop();
  say(`  Conta: ${account} · projeto: ${PROJECT}`);
  report.vercel = { conta: account, projeto: PROJECT };

  step('2. Credenciais SyncPay');
  const credentials = await readCredentials(ask, deps.root);
  report.credenciais = credentials.source;

  step('3. Conferindo na SyncPay');
  const token = await authenticate(deps, credentials);

  step('4. Webhook da Ayla');
  const webhook = await ensureWebhook(deps, token, { keepExisting: hasProductionWebhookSecret(deps, link) });
  report.webhook = { url: WEBHOOK_URL, id: webhook.id, acao: webhook.action, evento: 'transaction' };

  step('5. Variáveis na Vercel');
  const written = applyEnv(deps, link, null, envPlan({ credentials, webhook }));
  report.env = written.written;

  step('6. Checagem local');
  const check = spawnSync(process.execPath, [path.join('backend', 'tests', 'check.js')], { cwd: deps.root, encoding: 'utf8', env: base.cleanEnv() });
  if (check.status !== 0) throw fail('A checagem local falhou; nada foi publicado.');
  ok('sintaxe e boot do servidor OK');

  step('7. Preview (pagamento simulado)');
  const previewOut = deps.vercel(['deploy', '--yes']);
  const previewUrl = (previewOut.stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app/gi) || []).pop();
  if (previewOut.status !== 0 || !previewUrl) throw fail('Falha ao publicar o Preview: ' + scrub((previewOut.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')));
  ok('Preview publicado: ' + previewUrl);
  report.preview = { url: previewUrl, paginas: await smoke(deps, previewUrl, { staging: true }) };
  report.preview.checkout = await pixCheck(deps, previewUrl);
  if (!report.preview.checkout.simulado) throw fail('O Preview gerou cobrança que não é simulada. Parei antes da Production.');

  step('8. Production (SyncPay real)');
  const prodOut = deps.vercel(['deploy', '--prod', '--yes']);
  const prodUrl = (prodOut.stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app/gi) || []).pop();
  if (prodOut.status !== 0) throw fail('Falha ao publicar a Production: ' + scrub((prodOut.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')));
  ok('Production publicada: ' + ORIGIN + (prodUrl ? ` (${prodUrl})` : ''));
  report.production = { url: ORIGIN, paginas: await smoke(deps, ORIGIN, { staging: false }) };
  report.production.webhook = await webhookCheck(deps, ORIGIN, webhook.secret);
  report.production.checkout = await pixCheck(deps, ORIGIN);
  if (report.production.checkout.simulado) throw fail('A Production respondeu como simulada. Confira PAYMENT_PROVIDER.');

  const file = path.join(deps.root, '.audit', 'syncpay-ayla.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, scrub(JSON.stringify(report, null, 2)));
  step('Pronto — ' + ORIGIN + ' no ar com SyncPay. Resumo em .audit\\syncpay-ayla.json');
  say(scrub(JSON.stringify(report, null, 2)));
  return report;
}

module.exports = { main, envPlan, ensureWebhook, readCredentials, parseEnvFile, smoke, pixCheck, webhookCheck, probe, WEBHOOK_URL, ORIGIN };

if (require.main === module) {
  main().catch(error => {
    console.error('\n  [ERRO] ' + scrub(error.friendly ? error.message : (error.code ? error.code + ' ' : '') + error.message));
    process.exitCode = 1;
  });
}
