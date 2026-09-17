// Script de configuração da Ayla: validações sempre; fluxo completo quando há
// um PostgreSQL de teste (TEST_SETUP_PG_ADMIN_URL). Supabase e Vercel são falsos.
// Nenhum serviço externo, nenhuma credencial real.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../scripts/configurar-ayla');
const compat = require('../env-compat');

const REF = setup.EXPECTED_REF;
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = payload => [b64({ alg: 'HS256', typ: 'JWT' }), b64(payload), crypto.randomBytes(16).toString('base64url')].join('.');
const ANON = jwt({ iss: 'supabase', ref: REF, role: 'anon' });
const SERVICE = jwt({ iss: 'supabase', ref: REF, role: 'service_role' });
const SUPA_URL = ['https://', REF, '.supabase', '.co'].join('');

/* ------------------------------------------------------------ validações */
assert.equal(setup.checkKey(ANON, 'anon').ok, true);
assert.equal(setup.checkKey(SERVICE, 'service_role').ok, true);
assert.match(setup.checkKey(SERVICE, 'anon').reason, /service_role/);
assert.match(setup.checkKey(jwt({ ref: 'outroprojetooutroproj', role: 'anon' }), 'anon').reason, /OUTRO projeto/);
assert.equal(setup.checkKey('sb_publishable_abc123', 'anon').opaque, true);
assert.equal(setup.checkKey('sb_secret_abc123', 'service_role').opaque, true);
assert.equal(setup.checkKey('sb_secret_abc123', 'anon').ok, false);
assert.equal(setup.checkKey('qualquer-coisa', 'anon').ok, false);
assert.equal(setup.checkSupabaseUrl(SUPA_URL + '/').url, SUPA_URL);
assert.equal(setup.checkSupabaseUrl(['https://', 'outroref', '.supabase', '.co'].join('')).ok, false);
assert.equal(setup.checkSupabaseUrl('http://x').ok, false);

const poolerUri = `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-1-sa-east-1.pooler.supabase.com:6543/postgres`;
assert.deepEqual(setup.parsePooler(poolerUri), { ok: true, host: 'aws-1-sa-east-1.pooler.supabase.com' });
assert.equal(setup.parsePooler('aws-0-sa-east-1.pooler.supabase.com').ok, true);
assert.match(setup.parsePooler(poolerUri.replace(':6543', ':5432')).reason, /6543/);
assert.match(setup.parsePooler(`postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:5432/postgres`).reason, /host/);
assert.match(setup.parsePooler(poolerUri.replace('postgres.' + REF, 'postgres.outro')).reason, /outro projeto/);

const tricky = 'Abc@12#/:?%&x';
const url = setup.buildDatabaseUrl({ password: tricky, host: 'aws-1-sa-east-1.pooler.supabase.com' });
const parsed = require('pg-connection-string').parse(url);
assert.equal(parsed.password, tricky);
assert.equal(parsed.user, 'postgres.' + REF);
assert.equal(String(parsed.port), '6543');
assert.equal(parsed.host, 'aws-1-sa-east-1.pooler.supabase.com');

setup.remember(tricky);
assert.equal(setup.scrub(`senha ${tricky} e ${encodeURIComponent(tricky)}`), 'senha *** e ***');

const plan = setup.envPlan({ supabaseUrl: SUPA_URL, anonKey: ANON, serviceKey: SERVICE, databaseUrl: url });
const get = (key, target) => plan.find(p => p.key === key && p.target.includes(target));
assert.equal(get('CREATOR_SLUG', 'production').value, 'ayla');
assert.equal(get('DATABASE_SCHEMA', 'preview').value, 'ayla');
assert.equal(get('VIP_MEDIA_BUCKET', 'production').value, 'vip-ayla');
assert.equal(get('STAGING_DATABASE_SCHEMA', 'preview').value, 'staging_ayla_preview');
assert.equal(get('PAYMENT_PROVIDER', 'preview').value, 'staging');
assert.equal(get('PAYMENT_PROVIDER', 'production'), undefined, 'produção sem gateway real não recebe provider');
for (const key of ['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'VIP_MEDIA_SECRET', 'ADMIN_SESSION_SECRET', 'CRON_SECRET', 'SUPABASE_ANON_KEY']) {
  assert.equal(get(key, 'production').type, 'sensitive', key);
}
assert.ok(!/joice/i.test(JSON.stringify(plan)));

const env = compat.apply({ SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'sec' });
assert.equal(env.SUPABASE_ANON_KEY, 'pub');
assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'sec');
const kept = compat.apply({ SUPABASE_ANON_KEY: 'old', SUPABASE_PUBLISHABLE_KEY: 'new' });
assert.equal(kept.SUPABASE_ANON_KEY, 'old');
assert.equal(compat.isOpaqueKey('sb_secret_x'), true);
assert.equal(compat.isOpaqueKey(SERVICE), false);
console.log('PASS configurar-ayla: chaves/ref/role, URL, pooler :6543, senha com @ codificada, filtro de segredos, plano de ENV, compatibilidade de nomes');

/* ------------------------------------------------------ fluxo completo */
const adminUrl = process.env.TEST_SETUP_PG_ADMIN_URL;
if (!adminUrl) {
  console.log('SKIP configurar-ayla (fluxo completo): defina TEST_SETUP_PG_ADMIN_URL para rodar contra um PostgreSQL descartável');
  return;
}

const { Client } = require('pg');
const dbName = 'ayla_setup_' + crypto.randomBytes(4).toString('hex');
const dbPassword = 'Joao@teste#' + crypto.randomBytes(3).toString('hex');
const dbUser = 'ayla_backend_' + crypto.randomBytes(3).toString('hex');

function fakeSupabase({ opaqueRejected = false } = {}) {
  const buckets = new Map([['outro-bucket', { id: 'outro-bucket', public: true }]]);
  const users = [];
  const calls = [];
  async function fetchImpl(target, init = {}) {
    const u = new URL(target);
    const method = init.method || 'GET';
    const key = init.headers && init.headers.apikey;
    const auth = init.headers && init.headers.Authorization;
    calls.push(method + ' ' + u.pathname);
    const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
    assert.equal(u.origin, SUPA_URL);
    if (u.pathname.startsWith('/storage/v1/object/public/')) return reply(400, { error: 'not public' });
    if (key && auth !== 'Bearer ' + key) return reply(401, {});
    if (opaqueRejected && String(key).startsWith('sb_secret_') && u.pathname.startsWith('/storage/')) return reply(400, { message: 'Invalid Compact JWS' });
    if (u.pathname === '/auth/v1/settings') return key === ANON || String(key).startsWith('sb_') ? reply(200, {}) : reply(401, {});
    const admin = key === SERVICE || String(key).startsWith('sb_secret_');
    if (!admin) return reply(403, {});
    if (u.pathname === '/storage/v1/bucket' && method === 'GET') return reply(200, [...buckets.values()]);
    if (u.pathname === '/storage/v1/bucket' && method === 'POST') {
      const b = JSON.parse(init.body);
      if (buckets.has(b.id)) return reply(409, {});
      buckets.set(b.id, { id: b.id, public: b.public });
      return reply(200, { name: b.id });
    }
    const bucket = /^\/storage\/v1\/bucket\/(.+)$/.exec(u.pathname);
    if (bucket) {
      if (!buckets.has(bucket[1])) return reply(400, { statusCode: '404', error: 'Bucket not found' });
      if (method === 'PUT') { buckets.get(bucket[1]).public = JSON.parse(init.body).public; return reply(200, {}); }
      return reply(200, buckets.get(bucket[1]));
    }
    if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
      const b = JSON.parse(init.body);
      if (users.some(x => x.email === b.email)) return reply(422, { msg: 'already registered' });
      const user = { id: crypto.randomUUID(), email: b.email };
      users.push(user);
      return reply(200, user);
    }
    if (u.pathname === '/auth/v1/admin/users' && method === 'GET') return reply(200, { users });
    return reply(404, {});
  }
  return { fetch: fetchImpl, buckets, users, calls };
}

function fakeVercel(root) {
  const state = { project: null, envs: [], calls: [], inputs: [] };
  const vercel = (args, { input } = {}) => {
    state.calls.push(args.join(' '));
    if (input) state.inputs.push(input);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const [cmd, sub] = args;
    if (cmd === 'whoami') return ok('Vercel CLI 59\nconta-teste\n');
    if (cmd === 'project' && sub === 'inspect') return state.project ? ok('found') : { status: 1, stdout: '', stderr: 'not found' };
    if (cmd === 'project' && sub === 'add') { state.project = { id: 'prj_ayla123', name: args[2] }; return ok('created'); }
    if (cmd === 'link') {
      fs.mkdirSync(path.join(root, '.vercel'), { recursive: true });
      fs.writeFileSync(path.join(root, '.vercel', 'project.json'), JSON.stringify({ projectId: state.project.id, orgId: 'team_teste', projectName: args[3] }));
      return ok('Linked');
    }
    if (cmd === 'api') {
      const endpoint = args[1];
      assert.match(endpoint, /^\/v(9|10)\/projects\/prj_ayla123\/env(\/[^?]+)?\?teamId=team_teste$/);
      const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
      if (method === 'GET') return ok(JSON.stringify({ envs: state.envs.map(({ value, ...e }) => e) }));
      if (method === 'POST') {
        assert.ok(args.includes('--silent') && args.includes('--input'));
        const body = JSON.parse(input);
        state.envs.push({ id: 'env_' + state.envs.length + '_' + crypto.randomBytes(2).toString('hex'), ...body });
        return ok('');
      }
      if (method === 'DELETE') {
        const id = endpoint.split('/').pop().split('?')[0];
        state.envs = state.envs.filter(e => e.id !== id);
        return ok('');
      }
    }
    if (cmd === 'deploy') {
      assert.ok(!args.includes('--prod'), 'nunca produção');
      return ok('https://privacy-ayla-abc123-team.vercel.app\n');
    }
    return { status: 1, stdout: '', stderr: 'comando inesperado ' + args.join(' ') };
  };
  return { vercel, state };
}

function answers(list) {
  const queue = [...list];
  return async () => { assert.ok(queue.length, 'pergunta a mais'); return queue.shift(); };
}

async function run(deps) {
  const lines = [];
  const original = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { report: await setup.main(deps), out: lines.join('\n') }; } finally { console.log = original; }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayla-setup-'));
  fs.symlinkSync(path.resolve(__dirname, '..'), path.join(root, 'backend'), 'junction');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$`);
    await admin.query(`CREATE ROLE ${dbUser} LOGIN PASSWORD '${dbPassword.replace(/'/g, "''")}'`);
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${dbUser}`);
    const target = new URL(adminUrl);
    const databaseUrl = ['postgresql', '://', dbUser, ':', encodeURIComponent(dbPassword), '@', target.hostname, ':', target.port, '/', dbName].join('');
    const seed = new Client({ connectionString: databaseUrl });
    seed.on('error', () => {});
    await seed.connect();
    // O "outro" conteúdo do banco não pode ser tocado.
    await seed.query('CREATE TABLE public.sentinela(id int); INSERT INTO public.sentinela VALUES (42)');
    await seed.query('GRANT USAGE ON SCHEMA public TO anon');
    await seed.end();

    const cfg = { supabaseUrl: SUPA_URL, anonKey: ANON, serviceKey: SERVICE, databaseUrl };
    setup.remember(ANON, SERVICE, dbPassword, databaseUrl);
    const supa = fakeSupabase();
    const vc = fakeVercel(root);
    const email = 'dona.ayla@example.com';
    const adminPassword = 'SenhaAdmin@2026!';
    const deps = { cfg, cfgOverrides: { databaseSsl: false, allowAnyPort: true }, fetch: supa.fetch, vercel: vc.vercel, root,
      ask: answers(['s', email, adminPassword, 's', 's', 's']) };

    const first = await run(deps);
    // 1. schemas e migrations
    const check = new Client({ connectionString: databaseUrl });
    check.on('error', () => {});
    await check.connect();
    for (const schema of ['ayla', 'staging_ayla_preview']) {
      const t = await check.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('orders','entitlements','buyer_accounts','admin_users','vip_posts','vip_post_media')", [schema]);
      assert.equal(t.rows[0].n, 6, schema);
      const noRls = await check.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND c.relkind='r' AND NOT c.relrowsecurity AND c.relname<>'entitlement_duplicates_archive'", [schema]);
      if (noRls.rows[0].n) console.log(`INFO ${schema}: ${noRls.rows[0].n} tabela(s) sem RLS (fechadas por REVOKE)`);
      const anonUsage = await check.query("SELECT has_schema_privilege('anon',$1,'USAGE') AS u", [schema]);
      assert.equal(anonUsage.rows[0].u, false, 'anon sem acesso ao schema ' + schema);
      const row = await check.query(`SELECT role,email FROM "${schema}".admin_users`);
      assert.deepEqual(row.rows.map(r => [r.role, r.email]), [['admin', email]]);
      assert.equal((await check.query(`SELECT count(*)::int n FROM "${schema}".orders`)).rows[0].n, 0);
    }
    assert.equal((await check.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name='orders'")).rows[0].n, 0);
    assert.equal((await check.query('SELECT id FROM public.sentinela')).rows[0].id, 42);
    // 2. bucket
    assert.equal(supa.buckets.get('vip-ayla').public, false);
    assert.equal(supa.buckets.get('outro-bucket').public, true, 'outro bucket intocado');
    assert.equal(supa.users.length, 1);
    // 3. Vercel
    const keys = e => `${e.key}:${[].concat(e.target).sort().join('+')}`;
    const envs = new Map(vc.state.envs.map(e => [keys(e), e]));
    assert.equal(envs.get('DATABASE_URL:preview+production').value, databaseUrl);
    assert.equal(envs.get('APP_ENV:preview').value, 'staging');
    assert.equal(envs.get('APP_ENV:production').value, 'production');
    assert.equal(envs.get('VIP_MEDIA_BUCKET:preview+production').value, 'vip-ayla');
    assert.ok(envs.get('CRON_SECRET:preview+production').value.length >= 64);
    assert.ok(!vc.state.calls.some(c => c.includes('--prod')));
    assert.ok(!vc.state.calls.some(c => /joice/i.test(c)));
    assert.equal(first.report.preview, 'https://privacy-ayla-abc123-team.vercel.app');
    // 4. nenhum segredo na saída nem no relatório
    const saved = fs.readFileSync(path.join(root, '.audit', 'configuracao-ayla.json'), 'utf8');
    const generated = ['CRON_SECRET', 'VIP_MEDIA_SECRET', 'ADMIN_SESSION_SECRET'].map(k => envs.get(k + ':preview+production').value);
    for (const secret of [ANON, SERVICE, dbPassword, encodeURIComponent(dbPassword), databaseUrl, adminPassword, ...generated]) {
      assert.ok(!first.out.includes(secret), 'segredo na saída');
      assert.ok(!saved.includes(secret), 'segredo no relatório');
      assert.ok(!vc.state.calls.some(c => c.includes(secret)), 'segredo na linha de comando');
    }
    assert.ok(!/joice/i.test(saved));

    // Segunda execução: idempotente; segredos gerados mantidos; admin existente mantido.
    const before = generated.join();
    const second = await run({ ...deps, ask: answers(['s', email, adminPassword, 's', 's', 'n']) });
    const after = ['CRON_SECRET', 'VIP_MEDIA_SECRET', 'ADMIN_SESSION_SECRET'].map(k => vc.state.envs.find(e => e.key === k).value).join();
    assert.equal(after, before, 'segredos gerados preservados');
    assert.equal(vc.state.envs.filter(e => e.key === 'DATABASE_URL').length, 1, 'sem duplicata');
    assert.equal(vc.state.envs.filter(e => e.key === 'APP_ENV').length, 2);
    assert.equal(supa.users.length, 1);
    assert.equal((await check.query('SELECT count(*)::int n FROM ayla.admin_users')).rows[0].n, 1);
    assert.match(second.out, /já existia \(senha não alterada\)/);
    await check.end();

    // Chave sb_secret_ recusada pelo Storage: para antes de tocar no banco.
    const refused = fakeSupabase({ opaqueRejected: true });
    await assert.rejects(run({ ...deps, fetch: refused.fetch,
      cfg: { ...cfg, serviceKey: 'sb_secret_teste123456', serviceOpaque: true }, ask: answers([]) }), /Legacy anon, service_role/);

    // Projeto errado já vinculado: recusa sem mexer.
    fs.writeFileSync(path.join(root, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_x', orgId: 'team_teste', projectName: 'privacy-joice' }));
    const calls = vc.state.calls.length;
    await assert.rejects(run({ ...deps, ask: answers(['n', 's', 's']) }), /privacy-joice/);
    assert.ok(!vc.state.calls.slice(calls).some(c => c.startsWith('api') || c.startsWith('link')));

    console.log('PASS configurar-ayla (fluxo completo): schemas+migrations em PostgreSQL real, public intocado, anon sem acesso, bucket privado, ADMIN nos dois schemas, ENV Preview/Production sem duplicata, segredos nunca exibidos, reexecução idempotente, sb_secret_ recusada no Storage, vínculo errado bloqueado');
  } catch (error) {
    console.error('FALHA no fluxo completo:', error);
    process.exitCode = 1;
  } finally {
    await new Promise(r => setTimeout(r, 200));
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${dbUser}`).catch(() => {});
    await admin.end();
    fs.unlinkSync(path.join(root, 'backend'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
