'use strict';
/**
 * CONFIGURAÇÃO DA AYLA — Supabase + banco + Storage + admin + variáveis Vercel.
 *
 * Rode no SEU computador, na pasta E:\Privacy_Ayla:
 *     configurar_ayla.bat          (ou: node backend/scripts/configurar-ayla.js)
 *
 * Os segredos são digitados/colados no próprio terminal, sem aparecer na tela.
 * Este script:
 *   - nunca grava segredo em arquivo (nem .env, nem log, nem relatório);
 *   - nunca imprime segredo (erros passam por um filtro antes de aparecer);
 *   - só aceita o projeto Supabase da Ayla (ref conferido dentro das chaves);
 *   - só cria/usa o projeto Vercel "privacy-ayla";
 *   - só faz deploy de PREVIEW (Production continua exigindo pedido separado);
 *   - não mexe em nenhuma outra pasta nem em outro projeto.
 *
 * Etapas (cada uma pode ser repetida sem estragar nada — tudo é idempotente):
 *   1. coleta e valida as credenciais
 *   2. testa Auth e Storage com as chaves, do mesmo jeito que o backend usa
 *   3. monta DATABASE_URL do Transaction Pooler (porta 6543, senha codificada)
 *   4. cria schemas ayla e staging_ayla_preview e aplica as migrations
 *   5. garante o bucket PRIVADO vip-ayla
 *   6. (opcional) cria/garante o primeiro ADMIN
 *   7. grava as variáveis no projeto Vercel privacy-ayla (Preview e Production)
 *   8. (opcional) publica um Preview
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EXPECTED_REF = 'xztyqmiluvqsjzwofcem';
const PROJECT = 'privacy-ayla';
const BUCKET = 'vip-ayla';
const SCHEMAS = { production: 'ayla', preview: 'staging_ayla_preview' };
const PRODUCTION_ORIGIN = 'https://' + PROJECT + '.vercel.app';
const POOLER_PORT = '6543';

/* ================================================================ utilidades */

const secrets = new Set();
function remember(...values) { for (const v of values) if (v && String(v).length >= 6) secrets.add(String(v)); }
function scrub(text) {
  let out = String(text == null ? '' : text);
  for (const s of secrets) {
    out = out.split(s).join('***');
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join('***');
  }
  return out;
}
const say = (...parts) => console.log(scrub(parts.join(' ')));
const ok = msg => say('  [OK]  ' + msg);
const warn = msg => say('  [!!]  ' + msg);
const step = msg => say('\n== ' + msg);
function fail(message) { return Object.assign(new Error(message), { friendly: true }); }
function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  return (user || '').slice(0, 2) + '***@' + (domain || '');
}

/** Lê o payload de um JWT sem validar assinatura (só para conferir ref/role). */
function decodeJwt(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { return null; }
}

/**
 * Confere uma chave do Supabase.
 * role: 'anon' (pública) ou 'service_role' (secreta).
 */
function checkKey(value, role, ref = EXPECTED_REF) {
  const key = String(value || '').trim();
  if (!key) return { ok: false, reason: 'vazia' };
  const opaquePrefix = role === 'anon' ? 'sb_publishable_' : 'sb_secret_';
  if (key.startsWith('sb_')) {
    if (!key.startsWith(opaquePrefix)) return { ok: false, reason: `esperava uma chave ${opaquePrefix}... aqui` };
    return { ok: true, opaque: true, key };
  }
  const payload = decodeJwt(key);
  if (!payload) return { ok: false, reason: 'formato desconhecido (esperava eyJ... ou ' + opaquePrefix + '...)' };
  if (payload.ref !== ref) return { ok: false, reason: 'a chave é de OUTRO projeto Supabase (ref diferente)' };
  if (payload.role !== role) return { ok: false, reason: `a chave é "${payload.role}", esperava "${role}"` };
  return { ok: true, opaque: false, key };
}

function checkSupabaseUrl(value, ref = EXPECTED_REF) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(url);
  if (!match) return { ok: false, reason: 'formato esperado: https://<ref>.supabase.co' };
  if (match[1] !== ref) return { ok: false, reason: 'URL de OUTRO projeto Supabase' };
  return { ok: true, url };
}

/** Aceita só o host do pooler ou a URI inteira copiada do painel. */
function parsePooler(value, ref = EXPECTED_REF) {
  const raw = String(value || '').trim();
  let host = raw, port = POOLER_PORT, user = null;
  if (raw.includes('://')) {
    let parsed;
    // O painel mostra [YOUR-PASSWORD]; colchetes quebram o parser de URL.
    try { parsed = new URL(raw.replace(/\[[^\]]*\]/g, 'x')); } catch (_) { return { ok: false, reason: 'URI inválida' }; }
    host = parsed.hostname; port = parsed.port || '5432'; user = decodeURIComponent(parsed.username || '');
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/i.test(host)) {
    return { ok: false, reason: 'host do pooler inválido (esperado algo como aws-0-sa-east-1.pooler.supabase.com)' };
  }
  if (port !== POOLER_PORT) return { ok: false, reason: `porta ${port}: use o TRANSACTION pooler (porta ${POOLER_PORT})` };
  if (user && user !== 'postgres.' + ref) return { ok: false, reason: 'usuário do pooler é de outro projeto' };
  return { ok: true, host: host.toLowerCase() };
}

/** Nunca em código fixo: montada só em memória, com a senha codificada. */
function buildDatabaseUrl({ ref = EXPECTED_REF, password, host, port = POOLER_PORT, user }) {
  return ['postgresql', '://', encodeURIComponent(user || 'postgres.' + ref), ':', encodeURIComponent(password),
    '@', host, ':', port, '/postgres'].join('');
}

const generateSecret = () => crypto.randomBytes(32).toString('hex');

/* ================================================================== entrada */

function makePrompter(input = process.stdin, output = process.stdout) {
  // Sem terminal (testes/automação): lê linha a linha do stdin.
  if (!input.isTTY) {
    const lines = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    return Object.assign(async (question) => {
      output.write(question + '\n');
      if (!lines.length) throw fail('Faltou uma resposta ou um valor foi recusado acima. Confira os campos e rode de novo.');
      return lines.shift().trim();
    }, { batch: true });
  }
  return (question, { hidden = false } = {}) => new Promise(resolve => {
    output.write(question);
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    let value = '';
    const onData = chunk => {
      // Alguns terminais marcam a colagem com \x1b[200~ ... \x1b[201~.
      chunk = String(chunk).replace(/\x1b\[20[01]~/g, '');
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          input.setRawMode(false); input.pause(); input.removeListener('data', onData);
          output.write(hidden ? `  (${value.length} caracteres)\n` : '\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') { output.write('\nCancelado.\n'); process.exit(130); }
        if (ch === '\u0008' || ch === '\u007f') {
          if (value) { value = value.slice(0, -1); output.write(hidden ? '' : '\b \b'); }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        if (!hidden) output.write(ch);
      }
    };
    input.on('data', onData);
  });
}

async function confirm(ask, question) {
  const answer = (await ask(question + ' [s/n]: ')).toLowerCase();
  return answer === 's' || answer === 'sim' || answer === 'y';
}

/* ================================================================= supabase */

async function supabase(deps, cfg, method, route, { key, body } = {}) {
  const response = await deps.fetch(cfg.supabaseUrl + route, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    // Mesmo formato usado pelo backend (services/*.js).
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* corpo não-JSON */ }
  return { status: response.status, ok: response.ok, json };
}

async function probeSupabase(deps, cfg) {
  const auth = await supabase(deps, cfg, 'GET', '/auth/v1/settings', { key: cfg.anonKey });
  if (!auth.ok) {
    throw fail(`Auth recusou a chave pública (HTTP ${auth.status}).` + (cfg.anonOpaque
      ? ' Use a chave "anon" da aba "Legacy anon, service_role API keys" (começa com eyJ).' : ''));
  }
  ok('Supabase Auth respondeu com a chave pública');
  const storage = await supabase(deps, cfg, 'GET', '/storage/v1/bucket', { key: cfg.serviceKey });
  if (!storage.ok) {
    throw fail(`Storage recusou a chave secreta (HTTP ${storage.status}).` + (cfg.serviceOpaque
      ? ' A chave sb_secret_ não funciona nas chamadas diretas do backend. Use a "service_role" da aba'
        + ' "Legacy anon, service_role API keys" (começa com eyJ).' : ''));
  }
  ok('Supabase Storage respondeu com a chave secreta');
  const foreign = (Array.isArray(storage.json) ? storage.json : []).map(b => b.id || b.name).filter(id => /joice/i.test(id || ''));
  if (foreign.length) throw fail('Este projeto Supabase tem bucket da Joice (' + foreign.join(', ') + '). Projeto errado?');
  return { authOk: true, storageOk: true };
}

async function ensureBucket(deps, cfg) {
  const route = '/storage/v1/bucket/' + BUCKET;
  let current = await supabase(deps, cfg, 'GET', route, { key: cfg.serviceKey });
  let action = 'já existia';
  if (!current.ok) {
    const created = await supabase(deps, cfg, 'POST', '/storage/v1/bucket', {
      key: cfg.serviceKey, body: { id: BUCKET, name: BUCKET, public: false }
    });
    if (!created.ok && created.status !== 409) throw fail(`Não consegui criar o bucket ${BUCKET} (HTTP ${created.status}).`);
    action = 'criado';
    current = await supabase(deps, cfg, 'GET', route, { key: cfg.serviceKey });
  }
  if (current.ok && current.json && current.json.public !== false) {
    const fixed = await supabase(deps, cfg, 'PUT', route, { key: cfg.serviceKey, body: { public: false } });
    if (!fixed.ok) throw fail(`O bucket ${BUCKET} está PÚBLICO e não consegui torná-lo privado (HTTP ${fixed.status}).`);
    action += ' e estava público: agora é PRIVADO';
    current = await supabase(deps, cfg, 'GET', route, { key: cfg.serviceKey });
  }
  if (!current.ok || !current.json || current.json.public !== false) throw fail(`Não consegui confirmar que ${BUCKET} é privado.`);
  // Sem assinatura, o conteúdo não pode abrir.
  const anonymous = await deps.fetch(`${cfg.supabaseUrl}/storage/v1/object/public/${BUCKET}/ayla/posts/teste-acesso.jpg`,
    { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (anonymous.status === 200) throw fail(`O bucket ${BUCKET} está servindo arquivo sem assinatura.`);
  ok(`bucket ${BUCKET}: ${action}; privado confirmado; acesso sem assinatura bloqueado (HTTP ${anonymous.status})`);
  return { action, private: true };
}

async function findUserByEmail(deps, cfg, email) {
  for (let page = 1; page <= 50; page++) {
    const list = await supabase(deps, cfg, 'GET', `/auth/v1/admin/users?page=${page}&per_page=200`, { key: cfg.serviceKey });
    if (!list.ok) throw fail(`Não consegui listar usuários do Auth (HTTP ${list.status}).`);
    const users = (list.json && list.json.users) || [];
    const found = users.find(u => String(u.email || '').toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (users.length < 200) return null;
  }
  return null;
}

async function ensureAdminUser(deps, cfg, email, password) {
  const created = await supabase(deps, cfg, 'POST', '/auth/v1/admin/users', {
    key: cfg.serviceKey, body: { email, password, email_confirm: true }
  });
  if (created.ok && created.json && created.json.id) return { id: created.json.id, created: true };
  const existing = await findUserByEmail(deps, cfg, email);
  if (existing) return { id: existing.id, created: false };
  throw fail(`O Auth não criou o usuário admin (HTTP ${created.status}). Senha fraca ou e-mail inválido?`);
}

/* ==================================================================== banco */

async function withClient(deps, cfg, work) {
  const client = new deps.pg.Client({
    connectionString: cfg.databaseUrl,
    ssl: cfg.databaseSsl === false ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  });
  await client.connect();
  try { return await work(client); } finally { await client.end().catch(() => {}); }
}

async function roleExists(client, name) {
  return (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).rowCount > 0;
}

async function prepareDatabase(deps, cfg) {
  const port = new URL(cfg.databaseUrl.replace(/^postgresql:/, 'http:')).port;
  if (!cfg.allowAnyPort && port !== POOLER_PORT) throw fail('DATABASE_URL precisa usar a porta 6543 (Transaction Pooler).');

  await withClient(deps, cfg, async client => {
    await client.query('SELECT 1');
    ok('conexão com o banco OK' + (port === POOLER_PORT ? ' pelo Transaction Pooler :6543' : ''));
    for (const schema of Object.values(SCHEMAS)) await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    ok('schemas ayla e staging_ayla_preview garantidos');
  });

  // Migrations: exatamente o initDb() que o servidor usa, um schema por vez.
  const migrated = [];
  const saved = {};
  const keys = ['DATABASE_URL', 'DATABASE_SCHEMA', 'STAGING_DATABASE_SCHEMA', 'APP_ENV', 'CREATOR_SLUG', 'PGSSL', 'NODE_ENV'];
  for (const k of keys) saved[k] = process.env[k];
  try {
    const db = deps.postgresDriver();
    for (const [label, schema] of [['production', SCHEMAS.production], ['preview', SCHEMAS.preview]]) {
      Object.assign(process.env, { DATABASE_URL: cfg.databaseUrl, DATABASE_SCHEMA: SCHEMAS.production, CREATOR_SLUG: 'ayla' });
      delete process.env.NODE_ENV;
      if (cfg.databaseSsl === false) process.env.PGSSL = 'disable';
      if (label === 'preview') Object.assign(process.env, { APP_ENV: 'staging', STAGING_DATABASE_SCHEMA: schema });
      else delete process.env.APP_ENV;
      await db.initDb();
      await db.closeDb();
      migrated.push(schema);
      ok(`migrations aplicadas em ${schema}`);
    }
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }

  return withClient(deps, cfg, async client => {
    const status = {};
    const publicRoles = [];
    for (const role of ['anon', 'authenticated']) if (await roleExists(client, role)) publicRoles.push(role);
    for (const schema of Object.values(SCHEMAS)) {
      if (publicRoles.length) {
        const who = publicRoles.map(r => `"${r}"`).join(', ');
        await client.query(`REVOKE ALL ON SCHEMA "${schema}" FROM ${who}`);
        await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM ${who}`);
        await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${schema}" FROM ${who}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" REVOKE ALL ON TABLES FROM ${who}`);
      }
      const tables = (await client.query(
        "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY 1",
        [schema])).rows;
      const counts = {};
      for (const table of ['orders', 'entitlements', 'buyer_accounts', 'admin_users', 'vip_posts']) {
        if (tables.some(t => t.relname === table)) {
          counts[table] = Number((await client.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`)).rows[0].n);
        }
      }
      const withoutRls = tables.filter(t => !t.relrowsecurity).map(t => t.relname);
      status[schema] = { tables: tables.length, withoutRls, counts };
      ok(`${schema}: ${tables.length} tabelas; RLS ligado em ${tables.length - withoutRls.length}`
        + `; pedidos=${counts.orders ?? '-'}, compradores=${counts.buyer_accounts ?? '-'}, admins=${counts.admin_users ?? '-'}`);
    }
    if (publicRoles.length) ok(`schemas fechados para ${publicRoles.join(' e ')} (sem acesso pela Data API)`);
    return { migrated, status, revokedFrom: publicRoles };
  });
}

async function grantAdminRow(deps, cfg, user, email) {
  return withClient(deps, cfg, async client => {
    for (const schema of Object.values(SCHEMAS)) {
      await client.query(
        `INSERT INTO "${schema}".admin_users(user_id,email,role) VALUES ($1,$2,'admin')
         ON CONFLICT (user_id) DO UPDATE SET role='admin', email=EXCLUDED.email`, [String(user.id), email]);
    }
    ok(`ADMIN ${maskEmail(email)} liberado em ayla e staging_ayla_preview`);
  });
}

/* =================================================================== vercel */

/** Env limpo: o CLI da Vercel não precisa (nem deve) ver os segredos. */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['DATABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY', 'VIP_MEDIA_SECRET', 'ADMIN_SESSION_SECRET', 'CRON_SECRET', 'ADMIN_ACCESS_SECRET']) delete env[k];
  return env;
}

function realVercel(args, { input } = {}) {
  const win = process.platform === 'win32';
  const full = ['--yes', 'vercel@latest', ...args];
  const result = spawnSync(win ? 'npx.cmd' : 'npx', win ? full.map(a => `"${a}"`) : full, {
    cwd: ROOT, input, encoding: 'utf8', shell: win, env: cleanEnv(), maxBuffer: 20 * 1024 * 1024
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function readLink(root = ROOT) {
  const file = path.join(root, '.vercel', 'project.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function linkProject(deps, ask) {
  const who = deps.vercel(['whoami']);
  if (who.status !== 0) throw fail('Vercel CLI sem login. Rode "npx vercel login" e tente de novo.');
  const account = (who.stdout.trim().split(/\r?\n/).pop() || '').trim();
  say(`  Conta Vercel logada: ${account}`);
  if (!await confirm(ask, `  Criar/usar o projeto "${PROJECT}" nesta conta?`)) throw fail('Cancelado: conta Vercel não confirmada.');

  const current = readLink(deps.root);
  if (current && current.projectName && current.projectName !== PROJECT) {
    throw fail(`Esta pasta está ligada ao projeto "${current.projectName}". Esperava "${PROJECT}". Nada foi alterado.`);
  }
  const inspect = deps.vercel(['project', 'inspect', PROJECT]);
  if (inspect.status !== 0) {
    const add = deps.vercel(['project', 'add', PROJECT]);
    if (add.status !== 0 && !/already exists/i.test(add.stdout + add.stderr)) {
      throw fail('Não consegui criar o projeto na Vercel: ' + (add.stderr || add.stdout).trim().split(/\r?\n/).pop());
    }
    ok(`projeto Vercel ${PROJECT} criado`);
  } else ok(`projeto Vercel ${PROJECT} já existia`);

  const link = deps.vercel(['link', '--yes', '--project', PROJECT]);
  const linked = readLink(deps.root);
  if (link.status !== 0 || !linked || !linked.projectId) throw fail('Falha ao ligar a pasta ao projeto Vercel.');
  if (linked.projectName && linked.projectName !== PROJECT) throw fail(`Ligou no projeto errado (${linked.projectName}).`);
  if (/joice/i.test(JSON.stringify(linked))) throw fail('Vínculo aponta para algo da Joice. Parei.');
  ok(`pasta ligada ao projeto ${PROJECT}`);
  return { account, projectId: linked.projectId, orgId: linked.orgId };
}

function envEndpoint(link, suffix = '') {
  const team = String(link.orgId || '').startsWith('team_') ? `teamId=${link.orgId}` : '';
  const q = [team].filter(Boolean);
  return `/v10/projects/${link.projectId}/env${suffix}${q.length ? '?' + q.join('&') : ''}`;
}

function listEnv(deps, link) {
  const res = deps.vercel(['api', envEndpoint(link), '--raw']);
  if (res.status !== 0) throw fail('Não consegui ler as variáveis do projeto na Vercel.');
  let data;
  try { data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))); } catch (_) { throw fail('Resposta inesperada da Vercel ao listar variáveis.'); }
  return (data.envs || []).map(e => ({ id: e.id, key: e.key, target: [].concat(e.target || []), gitBranch: e.gitBranch || null }));
}

/**
 * Plano de variáveis. Segredos gerados só são criados se ainda não existirem
 * (rodar de novo não invalida sessões nem links já emitidos).
 */
function envPlan(cfg) {
  const both = ['production', 'preview'];
  const plan = [
    { key: 'SUPABASE_URL', value: cfg.supabaseUrl, target: both, type: 'encrypted' },
    { key: 'SUPABASE_ANON_KEY', value: cfg.anonKey, target: both, type: 'sensitive' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', value: cfg.serviceKey, target: both, type: 'sensitive' },
    { key: 'DATABASE_URL', value: cfg.databaseUrl, target: both, type: 'sensitive' },
    { key: 'VIP_MEDIA_SECRET', generate: true, target: both, type: 'sensitive' },
    { key: 'ADMIN_SESSION_SECRET', generate: true, target: both, type: 'sensitive' },
    { key: 'CRON_SECRET', generate: true, target: both, type: 'sensitive' },
    { key: 'CREATOR_SLUG', value: 'ayla', target: both, type: 'encrypted' },
    { key: 'DATABASE_SCHEMA', value: SCHEMAS.production, target: both, type: 'encrypted' },
    { key: 'VIP_MEDIA_BUCKET', value: BUCKET, target: both, type: 'encrypted' },
    { key: 'VIP_MEDIA_DRIVER', value: 'supabase', target: both, type: 'encrypted' },
    { key: 'VIP_MEDIA_DIRS', value: 'Media_Ayla', target: both, type: 'encrypted' },
    { key: 'VIP_MEDIA_TTL_SECONDS', value: '900', target: both, type: 'encrypted' },
    { key: 'SUPABASE_SIGNED_URL_TTL', value: '120', target: both, type: 'encrypted' },
    { key: 'BUYER_ACCOUNT_FLOW', value: 'true', target: both, type: 'encrypted' },
    { key: 'NODE_ENV', value: 'production', target: both, type: 'encrypted' },
    { key: 'ENABLE_TELEGRAM_BOT', value: 'false', target: both, type: 'encrypted' },
    { key: 'TELEGRAM_BOT_USERNAME', value: 'aylabl0nde_bot', target: both, type: 'encrypted' },
    { key: 'WHATSAPP_PRICE', value: '7.90', target: both, type: 'encrypted' },
    { key: 'ADMIN_UPLOAD_MAX_MB', value: '250', target: both, type: 'encrypted' },
    // Preview: pagamento simulado e schema próprio. As origens vêm do api/index.js.
    { key: 'APP_ENV', value: 'staging', target: ['preview'], type: 'encrypted' },
    { key: 'PAYMENT_PROVIDER', value: 'staging', target: ['preview'], type: 'encrypted' },
    { key: 'STAGING_DATABASE_SCHEMA', value: SCHEMAS.preview, target: ['preview'], type: 'encrypted' },
    // Production: sem gateway ainda. PAYMENT_PROVIDER fica de fora de propósito
    // (o servidor recusa subir em produção sem gateway real configurado).
    { key: 'APP_ENV', value: 'production', target: ['production'], type: 'encrypted' },
    { key: 'PUBLIC_APP_URL', value: PRODUCTION_ORIGIN, target: ['production'], type: 'encrypted' },
    { key: 'FRONTEND_URL', value: PRODUCTION_ORIGIN, target: ['production'], type: 'encrypted' },
    { key: 'ADMIN_ORIGIN', value: PRODUCTION_ORIGIN, target: ['production'], type: 'encrypted' }
  ];
  return plan;
}

function applyEnv(deps, link, cfg, plan = envPlan(cfg)) {
  const existing = listEnv(deps, link);
  const overlaps = (a, b) => a.some(t => b.includes(t));
  const written = [], kept = [];
  for (const item of plan) {
    const same = existing.filter(e => e.key === item.key && !e.gitBranch && overlaps(e.target, item.target));
    if (item.generate && same.length && item.target.every(t => same.some(e => e.target.includes(t)))) {
      kept.push(`${item.key} (${item.target.join('+')})`);
      continue;
    }
    for (const old of same) {
      const del = deps.vercel(['api', envEndpoint(link, '/' + old.id).replace('/v10/', '/v9/'), '-X', 'DELETE',
        '--dangerously-skip-permissions', '--silent']);
      if (del.status !== 0) throw fail(`Não consegui substituir ${item.key} na Vercel.`);
    }
    const value = item.generate ? generateSecret() : item.value;
    if (item.type === 'sensitive') remember(value);
    const res = deps.vercel(['api', envEndpoint(link), '-X', 'POST', '--input', '-', '--silent'], {
      input: JSON.stringify({ key: item.key, value, type: item.type, target: item.target })
    });
    if (res.status !== 0) throw fail(`A Vercel recusou a variável ${item.key}.`);
    written.push(`${item.key} (${item.target.join('+')})`);
  }
  ok(`${written.length} variáveis gravadas na Vercel` + (kept.length ? `; ${kept.length} segredos existentes mantidos` : ''));
  return { written, kept };
}

function deployPreview(deps) {
  const check = spawnSync(process.execPath, [path.join('backend', 'tests', 'check.js')], { cwd: deps.root, encoding: 'utf8', env: cleanEnv() });
  if (check.status !== 0) throw fail('A checagem local falhou; Preview não publicado.');
  const res = deps.vercel(['deploy', '--yes']);
  const url = (res.stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app/gi) || []).pop();
  if (res.status !== 0 || !url) throw fail('O deploy de Preview falhou: ' + scrub((res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')));
  ok('Preview publicado: ' + url);
  return url;
}

/* ============================================================== orquestração */

async function collect(ask) {
  step('1. Credenciais do Supabase da Ayla  (nada aparece na tela nem é salvo)');
  say('  Painel Supabase > Project Settings > API Keys > aba "Legacy anon, service_role API keys".');
  say('  As chaves sb_publishable_/sb_secret_ também são aceitas se passarem no teste, mas o recomendado são as legacy (eyJ...).\n');
  const cfg = {};
  for (;;) {
    const r = checkSupabaseUrl(await ask('  SUPABASE URL (https://....supabase.co): '));
    if (r.ok) { cfg.supabaseUrl = r.url; break; }
    warn(r.reason);
    if (ask.batch) throw fail('Valor recusado: ' + r.reason);
  }
  for (;;) {
    const r = checkKey(await ask('  Chave PÚBLICA (anon / publishable): ', { hidden: true }), 'anon');
    if (r.ok) { cfg.anonKey = r.key; cfg.anonOpaque = r.opaque; remember(r.key); break; }
    warn(r.reason);
    if (ask.batch) throw fail('Valor recusado: ' + r.reason);
  }
  for (;;) {
    const r = checkKey(await ask('  Chave SECRETA (service_role / secret): ', { hidden: true }), 'service_role');
    if (r.ok && r.key !== cfg.anonKey) { cfg.serviceKey = r.key; cfg.serviceOpaque = r.opaque; remember(r.key); break; }
    warn(r.ok ? 'a chave secreta não pode ser igual à pública' : r.reason);
    if (ask.batch) throw fail('Chave secreta recusada.');
  }
  say('\n  Supabase > botão Connect > "Transaction pooler". Cole a URI (com [YOUR-PASSWORD] mesmo) ou só o host.');
  for (;;) {
    const r = parsePooler(await ask('  Transaction pooler (URI ou host): '));
    if (r.ok) { cfg.poolerHost = r.host; break; }
    warn(r.reason);
    if (ask.batch) throw fail('Valor recusado: ' + r.reason);
  }
  for (;;) {
    const password = await ask('  Senha do banco: ', { hidden: true });
    if (password.length >= 6) { remember(password); cfg.databaseUrl = buildDatabaseUrl({ password, host: cfg.poolerHost }); remember(cfg.databaseUrl); break; }
    warn('senha muito curta');
    if (ask.batch) throw fail('Senha do banco recusada.');
  }
  return cfg;
}

async function main(deps = {}) {
  deps = {
    fetch: globalThis.fetch,
    pg: require('pg'),
    postgresDriver: () => require('../db/postgres'),
    vercel: realVercel,
    root: ROOT,
    ...deps
  };
  const ask = deps.ask || makePrompter();
  const report = { quando: new Date().toISOString() };

  say('==================================================');
  say('  CONFIGURAÇÃO AYLA  (Supabase ' + EXPECTED_REF + ')');
  say('==================================================');

  const cfg = deps.cfg || await collect(ask);
  Object.assign(cfg, deps.cfgOverrides || {});

  step('2. Testando Supabase');
  await probeSupabase(deps, cfg);
  report.supabase = 'Auth e Storage OK';
  report.chaves = cfg.anonOpaque || cfg.serviceOpaque ? 'formato novo (sb_)' : 'legacy JWT';

  step('3-4. Banco: schemas e migrations');
  report.banco = await prepareDatabase(deps, cfg);
  report.pooler = cfg.allowAnyPort ? 'porta de teste' : 'Transaction Pooler :6543';

  step('5. Storage');
  report.bucket = await ensureBucket(deps, cfg);

  step('6. Primeiro ADMIN');
  if (await confirm(ask, '  Criar/garantir o login de ADMIN da Ayla agora?')) {
    const email = await ask('  E-mail do admin: ');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('E-mail inválido.');
    let password = '';
    for (;;) {
      password = await ask('  Senha do admin (mín. 12 caracteres; se o e-mail já existir, a senha atual é mantida): ', { hidden: true });
      if (password.length >= 12) break;
      warn('use pelo menos 12 caracteres');
      if (ask.batch) throw fail('Senha do admin precisa de 12+ caracteres.');
    }
    remember(password);
    const user = await ensureAdminUser(deps, cfg, email, password);
    ok(`usuário ${maskEmail(email)} ${user.created ? 'criado' : 'já existia (senha não alterada)'} no Supabase Auth`);
    await grantAdminRow(deps, cfg, user, email);
    report.admin = `${maskEmail(email)} (${user.created ? 'criado' : 'existente'})`;
  } else {
    report.admin = 'não criado nesta execução';
    warn('ADMIN pulado. Rode de novo quando quiser criar.');
  }

  step('7. Variáveis na Vercel (projeto ' + PROJECT + ')');
  if (await confirm(ask, '  Gravar as variáveis no projeto Vercel agora?')) {
    const link = await linkProject(deps, ask);
    report.vercel = { conta: link.account, projeto: PROJECT, ...applyEnv(deps, link, cfg) };

    step('8. Preview');
    if (await confirm(ask, '  Publicar um PREVIEW agora (não é produção, não cobra nada)?')) {
      report.preview = deployPreview(deps);
      say('  Abra o link logado na Vercel. Teste: /  /login  /vip  /criadora/login');
    } else report.preview = 'não publicado';
  } else {
    report.vercel = 'não configurada nesta execução';
  }

  const out = path.join(deps.root, '.audit', 'configuracao-ayla.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, scrub(JSON.stringify(report, null, 2)));
  step('Pronto. Resumo (sem segredos) salvo em .audit\\configuracao-ayla.json');
  say(scrub(JSON.stringify(report, null, 2)));
  return report;
}

module.exports = {
  main, checkKey, checkSupabaseUrl, parsePooler, buildDatabaseUrl, decodeJwt, envPlan, scrub, remember,
  prepareDatabase, ensureBucket, probeSupabase, EXPECTED_REF, SCHEMAS, BUCKET, PROJECT,
  applyEnv, listEnv, envEndpoint, readLink, realVercel, makePrompter, confirm, say, ok, warn, step, fail, maskEmail,
  PRODUCTION_ORIGIN, cleanEnv
};

if (require.main === module) {
  main().catch(error => {
    console.error('\n  [ERRO] ' + scrub(error.friendly ? error.message : (error.code ? error.code + ' ' : '') + error.message));
    process.exitCode = 1;
  });
}
