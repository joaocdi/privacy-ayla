const crypto = require('crypto');
const { getDb, transaction } = require('../db/database');
const { fail } = require('./vip-posts');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
// Prefixo que marca, em admin_sessions.secret_version, uma sessão de e-mail.
const EMAIL_SESSION = 'supabase:';
const cookieName = () => process.env.NODE_ENV === 'production' ? '__Host-ayla-admin' : 'ayla-admin';
/**
 * Tamanho mínimo da chave administrativa.
 *
 * Em PRODUÇÃO continua exigindo 32+ caracteres: essa chave é a única coisa
 * entre a internet e o painel que envia mídia, troca o perfil público e lê o
 * conteúdo pago. Uma senha curta ali é força bruta em minutos.
 *
 * Em desenvolvimento (NODE_ENV != production) aceita 8+, para dar para entrar
 * no painel local sem carregar uma chave de 64 caracteres. O relaxamento vale
 * SÓ na máquina local — o deploy continua recusando chave curta no boot.
 */
function minimumSecretLength() {
  return process.env.NODE_ENV === 'production' ? 32 : 8;
}
function secret() {
  const value = process.env.ADMIN_ACCESS_SECRET || '';
  if (value.length < minimumSecretLength()) throw fail('Admin não configurado.', 503);
  return value;
}

/**
 * Chave usada para assinar o token anti-CSRF.
 *
 * Antes vinha do ADMIN_ACCESS_SECRET. Agora o login principal é por e-mail e
 * senha no Supabase Auth, e esse segredo pode nem existir — então a chave sai
 * da primeira variável disponível com tamanho suficiente. Em produção, se
 * nenhuma servir, falha fechada. No desenvolvimento usa uma chave aleatória por
 * processo: reiniciar invalida os formulários abertos, o que é chato e seguro.
 */
let processKey = null;
function signingKey() {
  for (const value of [process.env.ADMIN_SESSION_SECRET, process.env.ADMIN_ACCESS_SECRET, process.env.VIP_MEDIA_SECRET]) {
    if (typeof value === 'string' && value.length >= 32) return value;
  }
  if (process.env.NODE_ENV === 'production') throw fail('Admin não configurado.', 503);
  if (!processKey) processKey = crypto.randomBytes(32).toString('hex');
  return processKey;
}

/* ------------------------------------------------- login por e-mail e senha */

/**
 * Confere e-mail e senha no Supabase Auth, do lado do SERVIDOR.
 *
 * O navegador nunca recebe chave do Supabase nem o token de acesso dele: manda
 * e-mail e senha para o nosso backend, que fala com o Supabase e devolve apenas
 * o cookie de sessão HttpOnly que este projeto já usava. Também não existe
 * cadastro: só chamamos o endpoint de login, nunca o de signup.
 */
async function supabaseSignIn(email, password) {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!/^https:\/\//i.test(url) || !key) throw fail('Login por e-mail não está configurado no servidor.', 503);
  let response;
  try {
    response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key },
      body: JSON.stringify({ email, password })
    });
  } catch (_) {
    // Nunca repassamos o corpo da resposta: pode trazer detalhes da conta.
    throw fail('Não consegui falar com o servidor de login. Tente de novo.', 502);
  }
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const user = data && data.user;
  return user && typeof user.id === 'string' ? { id: user.id, email: user.email || null } : null;
}

/** A role vive no banco, não no token: revogar a linha derruba o acesso. */
async function adminRole(userId) {
  return (await getDb()).get("SELECT * FROM admin_users WHERE user_id=? AND role='admin'", String(userId));
}
function equal(a, b) { return crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
function token(req) {
  const name = cookieName() + '=';
  const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name))?.slice(name.length);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}
function csrf(value) { return crypto.createHmac('sha256', signingKey()).update('csrf:' + value).digest('hex'); }
function origin(req) {
  let expected;
  try {
    const configured = process.env.ADMIN_ORIGIN || process.env.PUBLIC_APP_URL;
    if (configured) expected = new URL(configured).origin;
    else if (process.env.NODE_ENV !== 'production') expected = `${req.protocol}://${req.get('host')}`;
  } catch (_) { /* fail closed */ }
  if (!expected || req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') throw fail('Origem administrativa inválida.', 403);
}
async function session(req) {
  const value = token(req);
  if (!value) return null;
  const row = await (await getDb()).get('SELECT * FROM admin_sessions WHERE id=? AND expires_at>?', hash(value), Date.now());
  if (!row) return null;
  // Sessão criada pelo login de e-mail: a autorização é reconferida agora.
  if (String(row.secret_version).startsWith(EMAIL_SESSION)) {
    const userId = String(row.secret_version).slice(EMAIL_SESSION.length);
    const admin = await adminRole(userId);
    return admin ? { ...row, user_id: userId, email: admin.email || null } : null;
  }
  // Sessão antiga, presa ao ADMIN_ACCESS_SECRET. Sem o segredo, não vale.
  let current;
  try { current = hash(secret()); } catch (_) { return null; }
  return row.secret_version === current ? row : null;
}

/**
 * Login por e-mail e senha. Autentica no Supabase Auth e só abre sessão se o
 * `auth.uid` estiver em `admin_users` com role admin. Assinante comum e conta
 * qualquer do Supabase passam pelo primeiro passo e param no segundo.
 */
async function loginWithEmail(req) {
  origin(req);
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string'
    || !email.includes('@') || email.length > 320 || password.length > 512 || !password) {
    throw fail('Informe e-mail e senha.', 400);
  }
  await countAttempt(req);
  const user = await supabaseSignIn(email.trim(), password);
  // Mesma mensagem para senha errada e para conta sem permissão: quem tenta
  // adivinhar não descobre quais e-mails existem nem quais são administradores.
  if (!user || !await adminRole(user.id)) throw fail('E-mail ou senha inválidos.', 401);
  const value = crypto.randomBytes(32).toString('hex');
  await (await getDb()).run('INSERT INTO admin_sessions(id,secret_version,expires_at) VALUES (?,?,?)',
    hash(value), EMAIL_SESSION + user.id, Date.now() + 12 * 60 * 60 * 1000);
  return value;
}
/** Limite de tentativas compartilhado pelos dois caminhos de login. */
async function countAttempt(req) {
  await transaction(async db => {
    const now = Date.now();
    await db.run('DELETE FROM admin_login_limits WHERE resets_at<?', now);
    await db.run('DELETE FROM admin_sessions WHERE expires_at<?', now);
    // Shared DB limits work across serverless instances, not only one process.
    for (const [key, limit] of [['global', 60], ['ip:' + hash(req.ip), 12]]) {
      await db.run('INSERT INTO admin_login_limits(id,attempts,resets_at) VALUES (?,0,?) ON CONFLICT(id) DO NOTHING', key, now + 15 * 60 * 1000);
      await db.run('UPDATE admin_login_limits SET attempts=attempts+1 WHERE id=?', key);
      const row = await db.get('SELECT attempts FROM admin_login_limits WHERE id=?', key);
      if (row.attempts > limit) throw fail('Muitas tentativas. Aguarde 15 minutos.', 429);
    }
  });
}

async function login(req) {
  origin(req);
  const configured = secret();
  await countAttempt(req);
  if (typeof req.body.secret !== 'string' || req.body.secret.length > 512 || !equal(req.body.secret, configured)) throw fail('Credencial administrativa inválida.', 401);
  const value = crypto.randomBytes(32).toString('hex');
  await (await getDb()).run('INSERT INTO admin_sessions(id,secret_version,expires_at) VALUES (?,?,?)', hash(value), hash(configured), Date.now() + 4 * 60 * 60 * 1000);
  return value;
}
function setCookie(res, value, logout = false) {
  res.cookie(cookieName(), value, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: logout ? 0 : 4 * 60 * 60 * 1000 });
}
async function requireSession(req, res, next) {
  try {
    req.admin = await session(req);
    if (!req.admin) throw fail('Entre novamente no painel.', 401);
    if (!['GET', 'HEAD'].includes(req.method)) {
      origin(req);
      if (!equal(req.get('x-csrf-token') || '', csrf(token(req)))) throw fail('Sessão de formulário inválida.', 403);
    }
    next();
  } catch (error) { next(error); }
}
module.exports = { login, loginWithEmail, session, requireSession, setCookie, token, csrf, hash, adminRole };
