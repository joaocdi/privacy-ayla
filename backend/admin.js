const express = require('express');
const path = require('path');
const auth = require('./services/admin-auth');
const posts = require('./services/vip-posts');
const profile = require('./services/profile');
const uploads = require('./services/admin-uploads');
const media = require('./services/vip-media');
const { getDb } = require('./db/database');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const directory = path.join(__dirname, 'admin-ui');

function install(app) {
  const pages = express.Router();
  const api = express.Router();
  function headers(req, res, next) {
    // Avatar/cover redirects use the configured Storage origin; no credentials.
    let imageOrigin = '';
    try { const url = new URL(process.env.SUPABASE_URL); if (url.protocol === 'https:') imageOrigin = ' ' + url.origin; } catch (_) { /* Storage not configured */ }
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      // data: in img-src only: the HOME preview derivative is rendered from a data URI.
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:" + imageOrigin + "; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  }
  pages.use(headers);
  api.use(headers);
  api.use(express.json({ limit: '100kb' }));
  pages.get('/login', (req, res) => res.sendFile(path.join(directory, 'login.html')));
  pages.get('/login.js', (req, res) => res.sendFile(path.join(directory, 'login.js')));
  pages.get('/style.css', (req, res) => res.sendFile(path.join(directory, 'style.css')));
  pages.use(wrap(async (req, res, next) => {
    if (!await auth.session(req)) return res.redirect(303, '/admin/login');
    next();
  }));
  pages.get('/', (req, res) => res.sendFile(path.join(directory, 'index.html')));
  pages.get('/app.js', (req, res) => res.sendFile(path.join(directory, 'app.js')));

  api.post('/login', wrap(async (req, res) => {
    const value = await auth.login(req);
    auth.setCookie(res, value);
    res.json({ ok: true });
  }));
  /**
   * Login por e-mail e senha (Supabase Auth). É o caminho principal a partir
   * de agora; o login por chave acima continua como ferramenta de emergência.
   */
  api.post('/login-email', wrap(async (req, res) => {
    const value = await auth.loginWithEmail(req);
    auth.setCookie(res, value);
    res.json({ ok: true });
  }));

  /**
   * "Sou admin?" — pública de propósito, porque a HOME e o /vip precisam
   * perguntar isso em toda visita. Para quem não é, responde `false` e nada
   * mais: nenhum token, nenhum dado de conta. O token anti-CSRF só sai para
   * quem já tem sessão válida.
   */
  api.get('/me', wrap(async (req, res) => {
    let current = null;
    try { current = await auth.session(req); } catch (_) { current = null; }
    if (!current) return res.json({ admin: false });
    res.json({ admin: true, email: current.email || null, csrf: auth.csrf(auth.token(req)) });
  }));

  api.use(auth.requireSession);
  api.get('/funnel', wrap(async(req,res)=>{const days=Number(req.query.days);if(![1,7,30].includes(days))return res.status(400).json({error:'Período inválido.'});res.json(await require('./services/analytics').funnel(days));}));
  api.get('/conversions', wrap(async (req,res)=>res.json(await require('./services/conversions').summary())));
  api.get('/profile', wrap(async (req, res) => res.json(await profile.get())));
  api.put('/profile', wrap(async (req, res) => res.json(await profile.save(req.body, req.admin.id))));
  api.get('/session', (req, res) => res.json({ csrf: auth.csrf(auth.token(req)), uploadMaxBytes: uploads.maxSize(), storage: media.driverName() }));
  api.post('/logout', wrap(async (req, res) => {
    await (await getDb()).run('DELETE FROM admin_sessions WHERE id=?', req.admin.id);
    auth.setCookie(res, '', true);
    res.json({ ok: true });
  }));
  api.get('/posts', wrap(async (req, res) => res.json({ posts: await posts.list(), source: await posts.source() })));
  // Com `mediaId`, entrega AQUELE item do carrossel; sem ele, a mídia que abre
  // a publicação. Tudo aqui já está atrás da sessão administrativa.
  api.get('/posts/:id/media/:mediaId?', wrap(async (req, res) => {
    const item = await posts.findMediaItem(req.params.id, req.params.mediaId || null, { publishedOnly: false });
    if (!item || !item.source || item.mediaDriver !== media.driverName()) throw posts.fail('Mídia indisponível neste ambiente.', 404);
    await media.deliver(req, res, item.source);
  }));
  api.post('/posts', wrap(async (req, res) => res.status(201).json(await posts.save(null, req.body, req.admin.id))));
  api.put('/posts/:id', wrap(async (req, res) => res.json(await posts.save(req.params.id, req.body, req.admin.id))));
  api.delete('/posts/:id', wrap(async (req, res) => {
    await posts.archive(req.params.id, true, req.body.version);
    res.json({ ok: true });
  }));
  // Exclusão permanente: além da sessão e do anti-CSRF, exige a confirmação
  // que a tela manda. Uma chamada solta, sem esse campo, não apaga nada.
  api.delete('/posts/:id/permanent', wrap(async (req,res) => {
    if (req.body.confirm !== 'EXCLUIR') throw posts.fail('Confirmação da exclusão não recebida.', 400);
    res.json(await posts.deletePermanent(req.params.id,req.body.version));
  }));
  api.post('/media-cleanup', wrap(async (req,res) => {
    const jobs = await (await getDb()).all("SELECT media_path FROM media_deletions WHERE status='pending' LIMIT 10");
    const results = [];
    for (const job of jobs) results.push(await require('./services/media-cleanup').clean(job.media_path));
    res.json({ results });
  }));
  api.post('/posts/:id/restore', wrap(async (req, res) => {
    await posts.archive(req.params.id, false, req.body.version);
    res.json({ ok: true });
  }));
  api.post('/feed-source', wrap(async (req, res) => {
    await posts.setSource(req.body.source);
    res.json({ source: await posts.source() });
  }));
  api.post('/migrate', wrap(async (req, res) => res.json({ imported: await posts.migrate() })));
  api.post('/uploads', wrap(async (req, res) => res.status(201).json(await uploads.start(req.body, req.admin.id))));
  api.get('/uploads/:id', wrap(async (req, res) => res.json(await uploads.status(req.params.id, req.admin.id))));
  api.patch('/uploads/:id', express.raw({ type: 'application/octet-stream', limit: uploads.CHUNK }), wrap(async (req, res) => {
    res.json(await uploads.chunk(req.params.id, req.admin.id, Number(req.get('upload-offset')), req.body));
  }));
  function errors(error, req, res, next) {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    const message = status === 413 ? 'Bloco de upload grande demais.' : error.type ? 'Requisição inválida.' : status === 500 ? 'Não foi possível concluir. Tente novamente.' : error.message;
    // Never log credentials, paths, request bodies or upstream error payloads.
    res.status(status).json({ error: message });
  }
  pages.use(errors);
  api.use(errors);
  app.use('/admin', pages);
  app.use('/api/admin', api);
}
module.exports = { install };
