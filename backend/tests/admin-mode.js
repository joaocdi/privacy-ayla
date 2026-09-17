/**
 * MODO ADMINISTRADOR NO PRÓPRIO SITE — autorização.
 *
 * O ponto destes testes não é a interface: é provar que esconder botão não é o
 * que protege nada. Visitante e assinante comum batem direto nos endpoints
 * administrativos e têm de levar 401/403, mesmo conhecendo a URL.
 *
 * O Supabase Auth é substituído por um `fetch` controlado: nenhuma conta real,
 * nenhuma senha real, nenhuma chamada de rede.
 */
require('./sqlite-env');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const directory = path.join(__dirname, '..', '.test-runs');
fs.mkdirSync(directory, { recursive: true });
process.env.DATABASE_PATH = path.join(directory, 'adminmode-' + crypto.randomUUID() + '.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.ENABLE_TELEGRAM_BOT = 'false';
process.env.FRONTEND_URL = '';
process.env.VIP_MEDIA_DRIVER = 'supabase';
process.env.SUPABASE_URL = 'https://auth-test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-key-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = crypto.randomBytes(32).toString('hex');
process.env.VIP_MEDIA_BUCKET = 'private-test';
process.env.ADMIN_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');

const ADMIN = { id: 'uid-admin-0001', email: 'ayla@exemplo.com', password: 'senha-correta' };
const OUTRO = { id: 'uid-comum-0002', email: 'assinante@exemplo.com', password: 'senha-comum' };

const realFetch = global.fetch;
let authCalls = 0;
let signupCalls = 0;
global.fetch = async (url, options = {}) => {
  const address = String(url);
  if (!address.startsWith(process.env.SUPABASE_URL)) return realFetch(url, options);
  const { pathname } = new URL(address);
  if (pathname === '/auth/v1/signup') { signupCalls++; return new Response('{}', { status: 200 }); }
  if (pathname === '/auth/v1/token') {
    authCalls++;
    // A chave do Supabase tem de sair do servidor, nunca do navegador.
    assert.equal(options.headers.apikey, process.env.SUPABASE_ANON_KEY);
    const body = JSON.parse(options.body);
    const conta = [ADMIN, OUTRO].find(c => c.email === body.email && c.password === body.password);
    return conta
      ? Response.json({ access_token: 'token-do-supabase', user: { id: conta.id, email: conta.email } })
      : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  }
  if (pathname.startsWith('/storage/v1/bucket/')) return Response.json({ public: false });
  if (pathname.includes('/object/sign/')) return Response.json({ signedURL: '/object/sign/private-test/mock?token=assinado-de-teste' });
  return new Response('{}', { status: 200 });
};

const { app } = require('../server');
const { initDb, getDb, closeDb } = require('../db/database');
const { createOrder, updateOrderPayment } = require('../services/orders');
const { confirmPayment } = require('../services/entitlements');

let server, base;
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }

async function request(route, { method = 'GET', body, headers = {}, cookie, csrf } = {}) {
  const options = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) options.headers.Cookie = cookie;
  if (csrf) options.headers['x-csrf-token'] = csrf;
  if (method !== 'GET') options.headers.Origin ??= base;
  if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers['Content-Type'] ??= 'application/json';
  }
  const response = await realFetch(base + route, options);
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, headers: response.headers, data, text };
}

async function entrar(conta) {
  const login = await request('/api/admin/login-email', { method: 'POST', body: { email: conta.email, password: conta.password } });
  if (login.status !== 200) return { status: login.status, data: login.data };
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await request('/api/admin/me', { cookie });
  return { status: 200, cookie, csrf: me.data.csrf, me: me.data };
}

async function main() {
  await initDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  process.env.ADMIN_ORIGIN = base;
  const db = await getDb();

  /* ------------------------------------------------ ninguém é admin ainda */

  check((await request('/api/admin/me')).data.admin === false, 'visitante recebe admin:false, sem token');
  check(!(await request('/api/admin/me')).text.includes('csrf'), 'resposta ao visitante não traz token anti-CSRF');
  const semRole = await entrar(ADMIN);
  check(semRole.status === 401, 'senha certa mas sem linha em admin_users não entra');

  /* ------------------------------------------ a role é o que abre a porta */

  await db.run("INSERT INTO admin_users(user_id,email,role) VALUES (?,?,'admin')", ADMIN.id, ADMIN.email);
  const errada = await request('/api/admin/login-email', { method: 'POST', body: { email: ADMIN.email, password: 'chute' } });
  check(errada.status === 401 && errada.data.error === 'E-mail ou senha inválidos.', 'senha errada recusada');
  const semConta = await request('/api/admin/login-email', { method: 'POST', body: { email: 'ninguem@exemplo.com', password: 'x' } });
  check(semConta.data.error === errada.data.error, 'conta inexistente e senha errada dão a mesma mensagem');

  const admin = await entrar(ADMIN);
  check(admin.status === 200 && admin.me.admin === true, 'admin entra com e-mail e senha');
  check(admin.me.email === ADMIN.email && typeof admin.csrf === 'string' && admin.csrf.length === 64, 'sessão devolve e-mail e token anti-CSRF');
  check(authCalls > 0 && signupCalls === 0, 'autenticou no Supabase e nunca chamou cadastro');

  const cru = await request('/api/admin/login-email', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.password } });
  check(/HttpOnly/i.test(cru.headers.get('set-cookie')) && /SameSite=Strict/i.test(cru.headers.get('set-cookie')), 'cookie HttpOnly e SameSite=Strict');
  check(!cru.text.includes('token-do-supabase') && !cru.text.includes(process.env.SUPABASE_ANON_KEY), 'nenhum token ou chave do Supabase volta para o navegador');

  /* ----------------------------------- conta comum autentica mas não passa */

  const comum = await entrar(OUTRO);
  check(comum.status === 401, 'conta válida do Supabase sem role admin é recusada');

  /* ------------------------------- assinante pagante também não é admin */

  const token = crypto.randomBytes(32).toString('hex');
  const pedido = await createOrder(require('../products').ayla_monthly, token, 'mock');
  await updateOrderPayment(pedido.public_id, await require('../payments/mock-provider').createPixPayment({ orderId: pedido.public_id }));
  await confirmPayment(pedido.public_id);
  const assinante = { Authorization: 'Bearer ' + token };
  check((await request('/api/vip/' + pedido.public_id, { headers: assinante })).data.granted === true, 'assinante enxerga o próprio VIP');
  check((await request('/api/admin/me', { headers: assinante })).data.admin === false, 'assinante não é admin');

  /* --------------- endpoints administrativos com quem não deve ter acesso */

  const proibidos = [
    ['GET', '/api/admin/posts'],
    ['POST', '/api/admin/posts'],
    ['PUT', '/api/admin/posts/qualquer'],
    ['DELETE', '/api/admin/posts/qualquer'],
    ['GET', '/api/admin/profile'],
    ['PUT', '/api/admin/profile'],
    ['POST', '/api/admin/uploads'],
    ['POST', '/api/admin/feed-source']
  ];
  for (const [method, route] of proibidos) {
    const anonimo = await request(route, { method, body: method === 'GET' ? undefined : {} });
    const pagante = await request(route, { method, headers: assinante, body: method === 'GET' ? undefined : {} });
    check([401, 403].includes(anonimo.status), `visitante barrado em ${method} ${route} (${anonimo.status})`);
    check([401, 403].includes(pagante.status), `assinante barrado em ${method} ${route} (${pagante.status})`);
  }

  /* --------------------------------------- o admin faz o ciclo completo */

  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120)]);
  await db.run("INSERT INTO vip_uploads(id,session_id,media_path,mime_type,type,size_bytes,received_bytes,complete,expires_at) VALUES ('up-1',?,'ayla/posts/a.png','image/png','image',?,?,1,?)",
    (await request('/api/admin/me', { cookie: admin.cookie })).data && require('../services/admin-auth').hash(admin.cookie.split('=')[1]),
    png.length, png.length, Date.now() + 3600000);

  const criado = await request('/api/admin/posts', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { caption: 'primeira pelo site', sort_order: 10, published: true, show_as_preview: false, uploadId: 'up-1' }
  });
  check(criado.status === 201 && criado.data.caption === 'primeira pelo site', 'admin cria publicação pela própria tela');
  const id = criado.data.id;

  const editado = await request('/api/admin/posts/' + id, {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { caption: 'legenda trocada', sort_order: 3, published: true, show_as_preview: false, version: criado.data.version }
  });
  check(editado.status === 200 && editado.data.caption === 'legenda trocada' && editado.data.sort_order === 3, 'admin edita legenda e ordem');

  /* ------------------------------- a criadora abre o /vip sem comprar nada */

  // O caminho administrativo é SEPARADO do caminho do comprador: ele não passa
  // por `orders` nem por `entitlements`. Estes contadores provam isso.
  const contar = async () => ({
    pedidos: Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n),
    pagos: Number((await db.get("SELECT COUNT(*) AS n FROM orders WHERE status='PAID'")).n),
    acessos: Number((await db.get('SELECT COUNT(*) AS n FROM entitlements')).n)
  });
  const antes = await contar();

  check((await request('/api/vip/preview')).status === 403, 'visitante não abre a área VIP pelo caminho administrativo');
  check((await request('/api/vip/preview', { headers: assinante })).status === 403, 'assinante pagante não vira admin pelo caminho administrativo');

  const tokenSemPagar = crypto.randomBytes(32).toString('hex');
  const semPagar = await createOrder(require('../products').ayla_monthly, tokenSemPagar, 'mock');
  check((await request('/api/vip/' + semPagar.public_id, { headers: { Authorization: 'Bearer ' + tokenSemPagar } })).status === 403,
    'pedido sem pagamento continua barrado na área VIP');
  check((await request('/api/vip/preview', { headers: { Authorization: 'Bearer ' + tokenSemPagar } })).status === 403,
    'quem não pagou também não entra pelo caminho administrativo');

  // No servidor real o boot já deixa o feed no banco; aqui o teste faz o mesmo.
  await request('/api/admin/feed-source', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { source: 'managed' } });
  const revisao = await request('/api/vip/preview', { cookie: admin.cookie });
  check(revisao.status === 200 && revisao.data.granted === true && revisao.data.admin === true, 'admin abre a área VIP com a própria sessão');
  check(revisao.data.expiresAt === null && revisao.data.productId === null, 'a revisão não finge ser assinatura: sem produto e sem validade');
  check(revisao.data.feed.some(p => p.id === id), 'a revisão mostra as publicações do feed');
  check(revisao.data.profile && revisao.data.profile.name !== undefined, 'a revisão mostra o mesmo perfil da página');

  const depois = await contar();
  check(antes.pagos === depois.pagos && antes.acessos === depois.acessos,
    'abrir a área VIP como admin não cria entitlement nem marca pagamento');

  /* --------------------------- a mesma autorização vale para a mídia VIP */

  const midia = revisao.data.feed.find(p => p.id === id).media;
  check(midia.startsWith('/api/vip/preview/media/'), 'a mídia da revisão passa por rota administrativa própria');
  check((await request(midia)).status === 403, 'visitante não abre a mídia da revisão');
  check((await request(midia, { headers: assinante })).status === 403, 'assinante pagante não abre a mídia da revisão');
  const entregue = await request(midia, { cookie: admin.cookie });
  check(entregue.status === 302, 'admin recebe a mídia protegida');
  check(!entregue.text.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), 'a entrega da mídia não vaza a chave do Storage');

  const semCsrf = await request('/api/admin/posts/' + id, {
    method: 'PUT', cookie: admin.cookie, csrf: 'errado',
    body: { caption: 'x', sort_order: 3, published: true, version: editado.data.version }
  });
  check(semCsrf.status === 403, 'sessão sem token anti-CSRF válido não altera nada');

  const despublicado = await request('/api/admin/posts/' + id, {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { caption: 'legenda trocada', sort_order: 3, published: false, show_as_preview: false, version: editado.data.version }
  });
  check(despublicado.status === 200 && despublicado.data.published === 0, 'admin despublica');

  // Rascunho: a criadora vê marcado como rascunho, o assinante não vê nada.
  const comRascunho = await request('/api/vip/preview', { cookie: admin.cookie });
  check(comRascunho.data.feed.find(p => p.id === id)?.draft === true, 'rascunho aparece marcado na revisão da criadora');
  check(!(await request('/api/vip/' + pedido.public_id, { headers: assinante })).data.feed.some(p => p.id === id), 'rascunho não aparece para o assinante');
  check((await request('/api/vip/preview/media/' + id, { headers: assinante })).status === 403, 'assinante não abre a mídia de um rascunho');

  const arquivado = await request('/api/admin/posts/' + id, { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf, body: { version: despublicado.data.version } });
  check(arquivado.status === 200, 'admin arquiva');
  const lista = await request('/api/admin/posts', { cookie: admin.cookie });
  check(lista.data.posts.find(p => p.id === id).archived === 1, 'arquivado preserva o registro');

  const perfil = await request('/api/admin/profile', { cookie: admin.cookie });
  const salvo = await request('/api/admin/profile', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { name: 'Ayla', username: '@ayla', bio: 'bio nova pelo site', version: perfil.data.version }
  });
  check(salvo.status === 200 && salvo.data.bio === 'bio nova pelo site', 'admin edita o perfil pela própria tela');
  check((await request('/api/profile')).data.bio === 'bio nova pelo site', 'HOME e VIP recebem o mesmo perfil salvo');

  /* ------------------------------- revogar a role derruba a sessão na hora */

  check((await request('/api/admin/me', { cookie: admin.cookie })).data.admin === true, 'sessão sobrevive ao refresh');
  await db.run('DELETE FROM admin_users WHERE user_id=?', ADMIN.id);
  check((await request('/api/admin/me', { cookie: admin.cookie })).data.admin === false, 'tirar a role derruba a sessão aberta');
  check((await request('/api/admin/posts', { cookie: admin.cookie })).status === 401, 'sem role, a API fecha mesmo com cookie válido');
  check((await request('/api/vip/preview', { cookie: admin.cookie })).status === 403, 'sem role, a área VIP fecha mesmo com cookie válido');
  await db.run("INSERT INTO admin_users(user_id,email,role) VALUES (?,?,'admin')", ADMIN.id, ADMIN.email);

  /* --------------------------------------------------------------- sair */

  const denovo = await entrar(ADMIN);
  const saiu = await request('/api/admin/logout', { method: 'POST', cookie: denovo.cookie, csrf: denovo.csrf, body: {} });
  check(saiu.status === 200, 'sair responde ok');
  check((await request('/api/admin/me', { cookie: denovo.cookie })).data.admin === false, 'depois de sair o cookie não vale mais');
  check((await request('/api/admin/posts', { cookie: denovo.cookie })).status === 401, 'depois de sair a API fecha');

  /* ------------------------------------------ os arquivos públicos do modo */

  // Procura os VALORES reais, não a palavra "Supabase" (que aparece em comentário).
  const segredos = [process.env.SUPABASE_ANON_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.ADMIN_ACCESS_SECRET, ADMIN.password, 'token-do-supabase'];
  for (const rota of ['/admin-mode.js', '/admin-mode.css', '/login', '/login.js', '/login.css']) {
    const arquivo = await request(rota);
    check(arquivo.status === 200, `${rota} é servido publicamente`);
    check(!segredos.some(valor => arquivo.text.includes(valor)), `${rota} não carrega nenhum segredo`);
  }

  console.log(`\nModo administrador: ${checks} verificações. Nenhuma conta real, nenhuma chamada de rede.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await closeDb();
  global.fetch = realFetch;
});
