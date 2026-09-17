require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('./env-compat');
require('./creator').assertConfiguration();
const path = require('path');
const express = require('express');
const cors = require('cors');

const products = require('./products');
const vipContent = require('./vip-content');

const creatorProfile = require('./services/profile');
const vipMedia = require('./services/vip-media');
const vipPosts = require('./services/vip-posts');
const adminAuth = require('./services/admin-auth');
const { initDb, getDb } = require('./db/database');
const paymentProvider = require('./payments/provider');
const { createOrder, getOrderByPublicId, updateOrderPayment, updateOrderStatus, beginPaymentCreation, failPaymentCreation, recoverCreation } = require('./services/orders');
const { confirmPayment, getExpiredEntitlements, expireEntitlement } = require('./services/entitlements');
const { generateAccessToken } = require('./services/access-tokens');
const { initBot, getBot, stopBot } = require('./telegram/bot');
const { kickUser } = require('./telegram/invites');

const app = express();
const buyerRecovery = require('./services/buyer-recovery');
const buyerPhone = require('./services/buyer-phone');
const buyerAccounts = require('./services/buyer-accounts');
const PORT = process.env.PORT || 3333;
const { hash, matches } = require('./services/security');

// Middlewares
// CORS restrito à origem do frontend quando FRONTEND_URL estiver definido.
// Sem isso qualquer site conseguia disparar pedidos no seu backend.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors((req, done) => done(null, {
  origin(origin, callback) {
    // Requisições sem Origin (curl, Postman, o próprio servidor estático) passam.
    if (!origin) return callback(null, true);
    try { if (new URL(origin).host === req.get('host')) return callback(null, true); } catch (_) {}
    if (allowedOrigins.length === 0 && process.env.NODE_ENV !== 'production') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origem não permitida: ${origin}`));
  }
})));

require('./admin').install(app);
// Preserve signed bytes only for the dedicated SyncPay webhook.
app.use(express.json({ limit: '100kb', verify(req, res, buffer) {
  if (req.originalUrl.split('?')[0] === '/api/webhooks/syncpay') req.syncpayRawBody = Buffer.from(buffer);
} }));
buyerAccounts.install(app);

/**
 * Rate limit simples em memória (sem dependência extra).
 * Evita que alguém crie milhares de pedidos em segundos.
 */
function rateLimit({ windowMs, max }) {
  const hits = new Map();

  // Poda as chaves expiradas para o Map não crescer indefinidamente.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Muitas requisições. Aguarde um instante.' });
    }

    return next();
  };
}

const pixRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10 });
const accessRateLimit = rateLimit({ windowMs: 60 * 1000, max: 20 });

// Serve frontend optionally
// Explicit public allowlist: never expose backend, database, archives or private media.
// A tela de entrada da criadora e o modo administrador embutido nas páginas
// entram aqui de propósito: não carregam segredo nenhum, e quem decide se
// existe sessão de admin é o backend, não estes arquivos.
const publicFiles = ['fonts.css', 'image-tools.js', 'index.html', 'app.js', 'style.css', 'avatar.jpg', 'cover.jpg', 'verified-ayla.png', 'favicon.ico',
  'vip.html', 'vip.css', 'vip.js',
  'tips.js','tips.css','pending-checkouts.js','buyer-account.html','buyer-account.css','buyer-account.js','login.html', 'login.css', 'login.js', 'admin-mode.css', 'admin-mode.js', 'admin-loader.js', 'frame.js', 'frame.css', 'carousel.js', 'carousel.css'];
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts'), { index: false, dotfiles: 'deny', maxAge: '1y', immutable: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
// A página VIP é pública como ARQUIVO; o conteúdo dela não. Sem assinatura
// ativa ela não recebe feed nem mídia — só a tela de acesso negado/expirado.
app.get('/vip', (req, res) => res.sendFile(path.join(__dirname, '..', 'vip.html')));
function accountPage(req,res){
  const route=req.path;
  const signup=route==='/criar-acesso',reset=route==='/redefinir-senha',recover=route==='/esqueci-senha',dashboard=route==='/meu-acesso';
  let html=require('node:fs').readFileSync(path.join(__dirname,'..','buyer-account.html'),'utf8');
  const title=signup?'Pagamento confirmado — crie seu acesso':reset?'Sua nova senha':recover?'Esqueci minha senha':dashboard?'Meu acesso':'Entrar';
  html=html.replace('<h1 id="title">Meu acesso</h1>','<h1 id="title">'+title+'</h1>');
  for(const [id,keep] of Object.entries({email:!reset&&!dashboard,phone:signup,password:!recover&&!dashboard,confirm:signup||reset})){
    const re=new RegExp('<label id="'+id+'Label"[^>]*>[\\s\\S]*?</label>');
    html=html.replace(re,match=>keep?match.replace(' hidden',''):'');
  }
  if(!dashboard)html=html.replace('<form id="accountForm" hidden>','<form id="accountForm">');
  html=html.replace('<div id="links" class="account-links"></div>','<div id="links" class="account-links"><a href="/esqueci-senha">Esqueci minha senha</a></div>');
  if(route==='/login')html=html.replace('Carregando seu acesso…','Acesse sua conta para ver seu conteúdo.');
  res.set('Cache-Control','no-store').type('html').send(html);
}
app.get('/login',accountPage);
app.get('/meu-acesso',async(req,res,next)=>{try{if(!await buyerAccounts.session(req))return res.redirect(303,'/login');accountPage(req,res);}catch(e){next(e);}});
app.get(['/criar-acesso','/esqueci-senha','/redefinir-senha'],accountPage);
app.get('/criadora/login',(req,res)=>res.sendFile(path.join(__dirname,'..','login.html')));
for (const file of publicFiles) app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, '..', file)));
// Only these pre-rendered blurred derivatives are public. No private media paths.
for (let index = 1; index <= 7; index++) {
  const file = `post-${String(index).padStart(2, '0')}.jpg`;
  app.get('/previews/' + file, (req, res) => res.sendFile(path.join(__dirname, '..', 'previews', file)));
}
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
/**
 * GET /api/home/previews
 *
 * A amostra BLOQUEADA da página de venda, gerenciada em /admin pelo campo
 * `show_as_preview`. Público de propósito — e por isso só devolve a derivada
 * minúscula gerada no painel, nunca `media_path`, nunca link assinado.
 * Sem posts marcados, devolve lista vazia e a HOME mantém as prévias estáticas.
 */
app.get('/api/home/previews', async (req, res) => {
  try {
    // Página do feed: sem parâmetro, continua entregando tudo (compatível).
    const previews = await vipPosts.homePreviews({
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      offset: req.query.offset === undefined ? undefined : Number(req.query.offset)
    });
    res.json({ previews, total: previews.total ?? previews.length, source: await vipPosts.source() });
  } catch (error) {
    console.error('Home previews failed:', error.name);
    res.json({ previews: [] });
  }
});
/**
 * GET /api/home/preview-video/:postId
 *
 * O teaser de ~5s da HOME. Público como a amostra JPEG e pelo mesmo motivo:
 * o que sai daqui é um arquivo DERIVADO — baixa resolução, sem áudio e com o
 * desfoque gravado dentro dele —, guardado em `ayla/previews/`.
 *
 * Três travas, e todas precisam passar:
 *   1. a publicação tem de estar publicada, não arquivada e marcada como prévia;
 *   2. o caminho lido tem de ser de teaser (`isPreviewPath`), então nem um
 *      registro adulterado consegue apontar esta rota para `ayla/posts/`;
 *   3. `media_path` não é lido em lugar nenhum deste handler.
 *
 * Isto NÃO é uma porta para a área VIP: não aceita pedido, não aceita token, e
 * o original continua exigindo entitlement ativo ou sessão de administrador.
 */
app.get('/api/home/preview-video/:postId/:mediaId?', async (req, res, next) => {
  try {
    // Com item, o teaser é o daquele item E ele tem de pertencer a este post.
    const teaser = await vipPosts.homeTeaserPath(req.params.postId, req.params.mediaId || null);
    if (!teaser) return res.sendStatus(404);
    // O navegador pode guardar a derivada: ela é pública por natureza.
    res.set('Cache-Control', 'public, max-age=300');
    return await vipMedia.deliver(req, res, teaser);
  } catch (error) { next(error); }
});
// Shared profile, including explicitly public branding images only.
app.get('/api/profile', async (req, res, next) => {
  try { const profile = await creatorProfile.get(); res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=600'); res.json(profile); } catch (error) { next(error); }
});
app.get('/api/profile/media/:role', async (req, res, next) => {
  if (!['avatar', 'cover'].includes(req.params.role)) return res.sendStatus(404);
  try {
    const image = await creatorProfile.image(req.params.role);
    if (!image.path) return res.redirect(302, image.fallback);
    if (vipMedia.driverName() !== 'supabase') return res.sendStatus(404);
    if (req.query.v !== String(image.version)) { res.set('Cache-Control', 'no-store'); return res.redirect(302, '/api/profile/media/' + req.params.role + '?v=' + image.version); }
    const payload = await require('./services/profile-media').bytes(image.path);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Vercel-CDN-Cache-Control', 'public, max-age=31536000, immutable');
    res.type(payload.type).send(payload.body);
  } catch (error) { next(error); }
});

// O destino privado só sai após comprovar a compra específica do contato.
function contactUrl() {
  const digits = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return null;
  const message = String(process.env.WHATSAPP_MESSAGE || '').slice(0, 200);
  return 'https://wa.me/' + digits + (message ? '?text=' + encodeURIComponent(message) : '');
}
async function contactAccess(order) {
  if (!order || order.status !== 'PAID' || order.product_id !== 'ayla_whatsapp_unlock' || order.access_type !== 'whatsapp' || order.grant_type !== 'contact') return false;
  return Boolean(await (await getDb()).get("SELECT id FROM entitlements WHERE order_id=? AND product_id='ayla_whatsapp_unlock' AND grant_type='contact' AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)", order.id));
}
app.get('/api/contact', (req, res) => res.json({ whatsapp: null, available: Boolean(contactUrl()), price: products.ayla_whatsapp_unlock.price }));
app.get('/api/contact/:orderId', authorizeOrder, async (req, res) => {
  try {
    if (!await contactAccess(req.order)) return res.status(403).json({ error: 'Contato ainda não liberado.' });
    const whatsapp = contactUrl();
    if (!whatsapp) return res.status(503).json({ error: 'Contato temporariamente indisponível.' });
    await require('./services/conversions').record('whatsapp_clicked',req.order.product_id,req.order.public_id).catch(()=>{});
    res.json({ whatsapp });
  } catch (_) { res.status(503).json({ error: 'Não foi possível consultar seu contato.' }); }
});
app.post('/api/conversions/checkout', rateLimit({windowMs:60000,max:20}), async (req,res)=>{
 const {productId,checkoutToken}=req.body||{};
 if(typeof productId!=='string'||!Object.hasOwn(products,productId)||typeof checkoutToken!=='string'||!/^[a-f0-9]{64}$/.test(checkoutToken))return res.status(400).json({error:'Evento inválido.'});
 try{await require('./services/conversions').record('checkout_opened',productId,checkoutToken);res.status(204).end();}catch(_){res.status(503).end();}
});
app.get('/api/tips/config', (req,res) => { const p=Object.values(products).find(p=>p.type==='tip');res.json({productId:p.id,minCents:p.minCents,maxCents:p.maxCents,available:!paymentProvider.requiresClient&&!paymentProvider.unavailable}); });
app.get('/api/catalog', (req, res) => res.json({ accountFlow:buyerAccounts.enabled(), staging:process.env.APP_ENV==='staging', requiresClient: paymentProvider.requiresClient, mock: ['mock','staging'].includes(paymentProvider.name), products: Object.values(products).filter(p => p.enabled !== false).map(p => ({ id: p.id, name: p.name, price: p.price })) }));
function bearer(req) { return /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1]; }
function owns(req, order) { return buyerRecovery.owns(order, bearer(req)); }
async function authorizeOrder(req, res, next) {
  try {
    const order = await getOrderByPublicId(req.params.orderId);
    const buyer=order?.claim_required?await buyerAccounts.session(req):null;
    const accountOwns=buyer && order?.buyer_id===buyer.user_id;
    const claimOwns=order?.claim_required && !order.buyer_id && matches(bearer(req),order.claim_token_hash);
    const allowed=order?.claim_required ? accountOwns || (req.path.endsWith('/status') && claimOwns) : await owns(req,order);
    if (!allowed) return res.status(403).json({ error: 'Acesso negado.' });
    req.order = order; next();
  } catch (error) { next(error); }
}
/**
 * Monta o feed para UM pedido. Cada mídia vira um link assinado só dele.
 * Post cujo arquivo ainda não existe fica de fora — as vagas em vip-content.js
 * podem ser preenchidas aos poucos sem quebrar a página.
 */
async function buildVipFeed(orderPublicId, orderId) {
  return (await vipPosts.feed(orderId))
    .filter((post) => post.type === 'cta' || (!post.draft && (!post.mediaDriver || post.mediaDriver === vipMedia.driverName()) && vipMedia.exists(post.source)))
    .map((post) => (post.type === 'cta'
      ? { id: post.id, type: 'cta', variant: post.variant, title: post.title, text: post.text, button: post.button }
      : {
        id: post.id,
        type: post.type,
        caption: post.caption || '',
        likes: post.likes || 0,
        crop: post.crop,
        realLikes: Boolean(post.realLikes),
        liked: Boolean(post.liked),
        comments: post.comments || 0,
        media: `/api/vip/media/${vipMedia.signLink(orderPublicId, post.id)}`,
        // Carrossel: um link assinado POR ITEM, cada um preso a este pedido e
        // àquela mídia. Post de uma mídia devolve uma posição só, e a página
        // desenha exatamente como antes.
        items: carouselFor(post, ref => `/api/vip/media/${vipMedia.signLink(orderPublicId, ref)}`)
      }));
}

/**
 * As mídias de um post prontas para a tela.
 *
 * Só entram itens cujo arquivo existe no Storage ativo — a mesma regra que o
 * feed já usava para a mídia única, agora aplicada item a item, para uma vaga
 * ainda sem arquivo não abrir um slide vazio no carrossel.
 *
 * `link(referencia)` monta o endereço; a referência carrega post e item, e é
 * ela que vai assinada. O caminho do arquivo não sai daqui.
 */
function carouselFor(post, link) {
  const items = Array.isArray(post.media) && post.media.length
    ? post.media
    : [{ id: null, type: post.type, source: post.source, mediaDriver: post.mediaDriver, crop: post.crop }];
  return items
    .filter(item => (!item.mediaDriver || item.mediaDriver === vipMedia.driverName()) && vipMedia.exists(item.source))
    .map((item, index) => ({
      id: item.id || post.id,
      type: item.type,
      crop: item.crop || null,
      position: index,
      media: link(item.id ? `${post.id}#${item.id}` : post.id)
    }));
}

async function activeAccess(order) {
  return require('./services/entitlements').activeSubscription(order);
}
/**
 * Autorização ADMINISTRATIVA da área VIP.
 *
 * Existem dois caminhos independentes para ver /vip, e eles não se misturam:
 *
 *   comprador → pedido PAID + entitlement ACTIVE  (authorizeOrder + activeAccess)
 *   criadora  → sessão Supabase válida + admin_users.role = 'admin'
 *
 * O caminho administrativo NÃO cria pedido, NÃO cria entitlement e NÃO marca
 * pagamento nenhum: ele simplesmente não passa por `orders`. Assinante sem
 * entitlement e visitante continuam barrados exatamente como antes, porque
 * nenhuma das checagens acima foi afrouxada.
 */
async function requireAdmin(req, res, next) {
  try {
    req.admin = await adminAuth.session(req);
    if (!req.admin) return res.status(403).json({ error: 'Acesso negado.' });
    next();
  } catch (error) { next(error); }
}

/**
 * GET /api/vip/preview
 *
 * A mesma tela do assinante, montada para revisão. Precisa vir ANTES de
 * `/api/vip/:orderId`, senão "preview" viraria um id de pedido.
 */
app.get('/api/vip/preview', requireAdmin, async (req, res, next) => {
  try {
    const feed = (await vipPosts.adminFeed())
      .filter((post) => post.type === 'cta' || ((!post.mediaDriver || post.mediaDriver === vipMedia.driverName()) && vipMedia.exists(post.source)))
      .map((post) => (post.type === 'cta'
        ? { id: post.id, type: 'cta', variant: post.variant, title: post.title, text: post.text, button: post.button }
        : {
          id: post.id,
          type: post.type,
          caption: post.caption || '',
          likes: post.likes || 0,
          crop: post.crop,
          realLikes: Boolean(post.realLikes),
          liked: false,
          draft: Boolean(post.draft),
          comments: post.comments || 0,
          // Sem link assinado: o cookie administrativo já viaja na requisição da
          // mídia, e ele não serve para mais ninguém.
          media: `/api/vip/preview/media/${encodeURIComponent(post.id)}`,
          items: carouselFor(post, ref => {
            const [postId, mediaId] = String(ref).split('#');
            return '/api/vip/preview/media/' + encodeURIComponent(postId) + (mediaId ? '/' + encodeURIComponent(mediaId) : '');
          })
        }));
    res.json({ granted: true, admin: true, productId: null, expiresAt: null, profile: await creatorProfile.get(), feed });
  } catch (error) { next(error); }
});

/**
 * GET /api/vip/preview/media/:postId
 *
 * Mídia protegida para a revisão administrativa. A autorização é a mesma de
 * cima e é reconferida aqui: a sessão precisa existir E o usuário precisa
 * continuar como admin no banco. Sem sessão, 403 — nada é entregue.
 */
app.get('/api/vip/preview/media/:postId/:mediaId?', requireAdmin, async (req, res, next) => {
  try {
    const post = await vipPosts.findMediaItem(req.params.postId, req.params.mediaId || null, { publishedOnly: false });
    if (!post || post.type === 'cta' || !post.source || (post.mediaDriver && post.mediaDriver !== vipMedia.driverName())) {
      return res.status(404).json({ error: 'Conteúdo não encontrado.' });
    }
    return await vipMedia.deliver(req, res, post.source);
  } catch (error) { next(error); }
});

/**
 * GET /api/vip/:orderId
 *
 * Autorização e conteúdo da área VIP, na MESMA checagem que já existia:
 * `authorizeOrder` prova a posse do pedido e `activeAccess` decide se há
 * assinatura válida. O feed só é montado depois disso — o frontend nunca
 * recebe caminho de mídia que ele não possa abrir.
 *
 * Distingue "expirado" de "negado" para a página poder oferecer renovação,
 * sem duplicar a regra: lê o mesmo entitlement.
 */
app.get('/api/vip/:orderId', authorizeOrder, async (req, res, next) => {
  try {
    const entitlement = await activeAccess(req.order);
    if (!entitlement || req.order.access_type !== 'vip') {
      const previous = req.order.access_type === 'vip'
        ? await (await getDb()).get('SELECT status, expires_at FROM entitlements WHERE order_id=?', req.order.id)
        : null;
      const expired = Boolean(previous) && req.order.status === 'PAID';
      return res.status(403).json({ error: expired ? 'Seu acesso expirou.' : 'Acesso negado.', expired });
    }

    // Só o que a tela precisa. Nada de dados do comprador, hash ou token.
    res.json({
      granted: true,
      productId: entitlement.product_id,
      expiresAt: entitlement.expires_at,
      profile: await creatorProfile.get(),
      feed: await buildVipFeed(req.order.public_id, req.order.id)
    });
  } catch (error) { next(error); }
});

/**
 * GET /api/vip/media/:token
 *
 * <img> e <video> não mandam header Authorization, então a autorização viaja
 * num link assinado (curta duração, preso a um pedido e a um post). O link diz
 * de quem é; quem decide continua sendo o banco, reconferido aqui.
 */
app.get('/api/vip/media/:token', async (req, res, next) => {
  try {
    const link = vipMedia.verifyLink(req.params.token);
    if (!link) return res.status(403).json({ error: 'Link inválido ou expirado.' });

    const order = await getOrderByPublicId(link.orderId);
    if (!order || order.access_type !== 'vip' || !await activeAccess(order)) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    // A referência assinada carrega "post#item" quando é carrossel. O item é
    // reconferido no banco contra ESTE post: link de um não abre mídia do outro.
    const [postId, mediaId] = String(link.postId).split('#');
    const post = await vipPosts.findMediaItem(postId, mediaId, { publishedOnly: true });
    if (!post || post.type === 'cta' || !post.source || (post.mediaDriver && post.mediaDriver !== vipMedia.driverName())) return res.status(404).json({ error: 'Conteúdo não encontrado.' });

    return await vipMedia.deliver(req, res, post.source);
  } catch (error) { next(error); }
});

app.put('/api/vip/:orderId/posts/:postId/like', authorizeOrder, async (req, res, next) => {
  try {
    if (req.order.access_type !== 'vip' || !await activeAccess(req.order)) return res.status(403).json({ error: 'Acesso negado.' });
    res.json(await vipPosts.like(req.params.postId, req.order.id, req.body.liked));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', payments: paymentProvider.unavailable ? 'unavailable' : 'ok', timestamp: new Date().toISOString() });
});

// POST /api/payments/pix
app.post('/api/buyer/recovery/request', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await buyerRecovery.request(req.body?.phone, req.ip)); }
  catch (e) { res.status(e.status || 503).json({ error: e.status ? e.message : 'Recuperação indisponível.' }); }
});
app.post('/api/buyer/recovery/verify', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await buyerRecovery.verify(req.body?.challenge, req.body?.code, req.ip)); }
  catch (e) { res.status(e.status || 503).json({ error: e.status ? e.message : 'Recuperação indisponível.' }); }
});
app.post('/api/payments/pix', pixRateLimit, async (req, res) => {
  let order;
  let creationClaimed = false;
  try {
    const { productId, checkoutToken, client } = req.body || {};
    if (typeof productId !== 'string') return res.status(400).json({ error: 'productId obrigatório.' });
    if (!Object.hasOwn(products, productId)) return res.status(404).json({ error: 'Produto não encontrado.' });
    const product = require('./services/tips').resolve(products[productId], req.body.tipAmountCents);
    if (product.enabled === false) return res.status(409).json({ error: 'Este produto ainda não está disponível.' });
    if (typeof checkoutToken !== 'string' || !/^[a-f0-9]{64}$/.test(checkoutToken)) return res.status(400).json({ error: 'Token de checkout inválido.' });
    if (paymentProvider.requiresClient && !paymentProvider.validateClient(client)) return res.status(400).json({ error: 'Preencha nome, e-mail, telefone e CPF/CNPJ.' });
    if (product.type !== 'tip' && !buyerAccounts.enabled() && !paymentProvider.requiresClient && !buyerPhone(client?.phone)) return res.status(400).json({ error: 'Informe seu celular com DDD.' });
    if(buyerAccounts.enabled() && paymentProvider.requiresClient) return res.status(503).json({error:'Este provedor não suporta checkout sem dados. Use SyncPay.'});
    if (paymentProvider.configuration) paymentProvider.configuration();
    const customer = (buyerAccounts.enabled() || product.type === 'tip')?null:paymentProvider.requiresClient ? client : { phone: buyerPhone(client.phone) };
    const buyer=buyerAccounts.enabled()?await buyerAccounts.session(req):null;
    if(buyer)buyerAccounts.origin(req);
    order = await createOrder(product, checkoutToken, paymentProvider.name, customer,buyer?.user_id||null);
    order = await recoverCreation(order);
    if (order.payment_provider !== paymentProvider.name && ['CREATING', 'FAILED'].includes(order.status)) {
      return res.status(409).json({ error: 'Este pedido precisa ser verificado antes de tentar novamente.', orderId: order.public_id, status: order.status, retryable: false, requiresReview: true });
    }
    creationClaimed = await beginPaymentCreation(order.public_id);
    if (creationClaimed) {
      const payment = await paymentProvider.createPixPayment({ orderId: order.public_id, product: { ...product, price: Number(order.amount) }, client });
      await updateOrderPayment(order.public_id, payment);
    }
    order = await getOrderByPublicId(order.public_id);
    if (order.status === 'CREATING') return res.status(202).json({ orderId: order.public_id, status: order.status });
    if (order.status === 'FAILED') {
      const retryable = order.creation_phase === 'retryable';
      return res.status(409).json({
        error: retryable ? 'Não foi possível gerar o PIX. Tente novamente.' : 'Não foi possível confirmar a geração deste PIX. Seu pedido está em verificação; não faça outro pagamento.',
        orderId: order.public_id, status: order.status, retryable, requiresReview: !retryable
      });
    }
    return res.status(creationClaimed ? 201 : 200).json({
      orderId: order.public_id, status: order.status, expiresAt: order.expires_at,
      product: { id: order.product_id, name: product.name, price: order.amount },
      pix: { copyPaste: order.pix_copy_paste, qrCode: order.pix_qr_code }, mock: ['mock','staging'].includes(paymentProvider.name), accountFlow:!!order.claim_required, staging:paymentProvider.name==='staging'
    });
  } catch (error) {
    if (creationClaimed) await failPaymentCreation(order.public_id, error.paymentCreationSafeToRetry === true).catch(() => {});
    console.error('PIX creation failed:', error.name); // Never log provider responses, customer data or keys.
    const failed = order ? await getOrderByPublicId(order.public_id).catch(() => null) : null;
    const requiresReview = failed?.status === 'FAILED' && failed.creation_phase !== 'retryable';
    const retryable = !requiresReview;
    res.status(error.status || 502).json({
      error: requiresReview ? 'Não foi possível confirmar a geração deste PIX. Seu pedido está em verificação; não faça outro pagamento.' : 'Não foi possível gerar o PIX. Tente novamente para retomar o mesmo pedido.',
      orderId: order?.public_id, status: failed?.status, retryable, requiresReview
    });
  }
});

// GET /api/orders/:orderId/status
app.get('/api/orders/:orderId/status', authorizeOrder, async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await recoverCreation(await getOrderByPublicId(orderId));

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    // Polling only reads persisted state. Expiry is a visual hint, not approval.
    const displayStatus = order.status === 'PENDING' && order.expires_at && Date.parse(order.expires_at.replace(' ', 'T') + 'Z') <= Date.now() ? 'EXPIRED' : order.status;
    // Only update frontend state, does NOT decide if it's approved.
    return res.json({
      orderId: order.public_id,
      status: displayStatus, expiresAt: order.expires_at,
      retryable: order.creation_phase === 'retryable' || (order.status === 'CREATING' && order.creation_phase === 'ready'),
      requiresReview: order.status === 'FAILED' && order.creation_phase !== 'retryable',
      accountFlow:!!order.claim_required, needsClaim:!!order.claim_required&&!order.buyer_id&&order.status==='PAID',
      granted: Boolean(order.access_type === 'vip' && await activeAccess(order)),
      contactGranted: await contactAccess(order)
    });
  } catch (error) {
    console.error('Erro ao consultar status:', error);
    return res.status(500).json({ error: 'Erro ao consultar status do pagamento.' });
  }
});

app.post('/api/staging/confirm',async(req,res)=>{
  if(process.env.APP_ENV!=='staging'||paymentProvider.name!=='staging')return res.sendStatus(404);
  try{
    buyerAccounts.origin(req);
    const order=await getOrderByPublicId(req.body.orderId);
    if(!order||order.payment_provider!=='staging'||!matches(req.body.claimToken,order.purchase_kind==='tip'?order.checkout_hash:order.claim_token_hash))return res.sendStatus(403);
    await confirmPayment(order.public_id);return res.json({simulated:true});
  }catch(e){res.status(e.status||500).json({error:'Simulação indisponível.'});}
});
app.post('/api/webhooks/syncpay', async (req, res) => {
  const syncpay = require('./payments/syncpay-provider');
  if (!process.env.SYNCPAY_WEBHOOK_SECRET) return res.status(503).json({error:'Webhook não configurado.'});
  if (!syncpay.validateSignature(req.syncpayRawBody, req.get('X-SyncPay-Signature'))) return res.status(401).json({error:'Assinatura inválida.'});
  try {
    const parsed = syncpay.parseWebhook(req.body, req.headers);
    if (parsed.ignored || !parsed.paid) return res.json({received:true,ignored:true});
    if (parsed.method !== 'pix' || parsed.currency !== 'BRL') return res.status(409).json({error:'Método ou moeda divergente.'});
    if (typeof parsed.amount !== 'number' || !Number.isFinite(parsed.amount) || parsed.amount <= 0 || Math.abs(parsed.amount*100-Math.round(parsed.amount*100))>0.000001) return res.status(409).json({error:'Valor inválido.'});
    const db = await getDb();
    const order = await db.get("SELECT * FROM orders WHERE payment_provider='syncpay' AND provider_payment_id=?", parsed.providerPaymentId);
    if (!order) {
      // A conta SyncPay é compartilhada entre as criadoras e o webhook é da
      // CONTA: transação da outra chega aqui também. Depois da assinatura
      // conferida, ela é reconhecida e ignorada — sem order, sem entitlement,
      // sem consultar comprador e sem 404 em série derrubando o webhook.
      // Exceção: se existe cobrança NASCENDO agora, o identifier pode ser
      // desta casa e ainda não ter sido gravado — aí 404 pede reentrega.
      const nascendo = await db.get("SELECT id FROM orders WHERE payment_provider='syncpay' AND status='CREATING' AND created_at > datetime('now','-15 minutes') LIMIT 1");
      if (nascendo) return res.status(404).json({error:'Transação ainda não registrada.'});
      return res.json({received:true,ignored:true,reason:'outra criadora'});
    }
    await confirmPayment(order.public_id, {provider:'syncpay',identifier:parsed.providerPaymentId,cents:Math.round(parsed.amount*100)});
    return res.json({received:true,status:'PAID'});
  } catch (error) {
    return res.status(error.status || 500).json({error:'Webhook não processado.'});
  }
});

// POST /api/payments/webhook
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const payload = req.body;
    if (typeof payload?.token !== 'string' || !payload.token || payload.token.length > 512) return res.status(401).json({ error: 'Webhook inválido.' });
    const db = await getDb();
    const legacyProvider = paymentProvider.name === 'mock' ? paymentProvider : require('./payments/sigilopay-provider');
    const order = await db.get('SELECT * FROM orders WHERE webhook_token_hash=? AND payment_provider=?', hash(payload.token), legacyProvider.name);
    if (!order || !await legacyProvider.validateWebhook(payload, order)) return res.status(401).json({ error: 'Webhook inválido.' });
    const parsed = legacyProvider.parseWebhook(payload);
    if (parsed.providerPaymentId != null && String(parsed.providerPaymentId) !== order.provider_payment_id) return res.status(401).json({ error: 'Transação divergente.' });
    if (parsed.event !== 'TRANSACTION_PAID') return res.json({ received: true, ignored: true });
    await confirmPayment(order.public_id);
    return res.json({ received: true, status: 'PAID' });
  } catch (error) {
    console.error('Webhook processing failed:', error.name);
    return res.status(500).json({ error: 'Erro ao processar webhook.' });
  }
});

/**
 * GET /api/access/:orderId
 * Emite o link do bot do Telegram para um pedido pago.
 *
 * Como só guardamos o HASH do token, não dá para reexibir um token antigo:
 * geramos um novo e `generateAccessToken` invalida os anteriores não usados,
 * de modo que só existe um link válido por pedido ao mesmo tempo.
 *
 * Proteções: rate limit por IP e recusa quando o acesso já foi resgatado por
 * uma conta do Telegram (evita que alguém de posse do orderId gere um segundo
 * link e roube o acesso do comprador).
 */
app.get('/api/access/:orderId', accessRateLimit, authorizeOrder, async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderByPublicId(orderId);

    if (!order || order.status !== 'PAID') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const db = await getDb();
    const entitlement = await db.get(
      `SELECT * FROM entitlements WHERE order_id = ?`,
      [order.id]
    );

    if (!entitlement) {
      return res.status(409).json({ error: 'Acesso ainda não liberado. Tente novamente em instantes.' });
    }

    if (!await activeAccess(order) || order.access_type !== 'vip') {
      return res.status(403).json({ error: 'Este acesso não está mais ativo.' });
    }

    if (entitlement.telegram_user_id) {
      return res.status(409).json({
        error: 'Este pedido já foi vinculado a uma conta do Telegram. Abra a conversa com o bot para reentrar.'
      });
    }

    let botUsername = process.env.TELEGRAM_BOT_USERNAME;
    const botConfigured = botUsername && botUsername !== 'YOUR_BOT_USERNAME_HERE';

    if (!botConfigured) {
      return res.status(503).json({ error: 'Pagamento confirmado. A entrega pelo Telegram ainda não foi configurada. Entre em contato com o suporte.' });
    }

    const rawToken = await generateAccessToken(order.id);

    return res.json({ url: `https://t.me/${botUsername}?start=${rawToken}` });
  } catch (error) {
    console.error('Erro ao emitir acesso:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// DEV ROUTE: Simular pagamento
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL && paymentProvider.name === 'mock') {
  app.post('/api/dev/orders/:orderId/pay', authorizeOrder, async (req, res) => {
    try {
      const { orderId } = req.params;
      const order = await getOrderByPublicId(orderId);
      if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
      if (order.status === 'PAID') return res.status(400).json({ error: 'Já está pago.' });

      await confirmPayment(order.public_id);
      
      return res.json({ success: true, message: 'Pagamento simulado.' });
    } catch (error) {
      return res.status(500).json({ error: 'Erro interno simulando pagamento.' });
    }
  });
}

// Expiração de acessos.
async function runExpiration() {
  const expired = await getExpiredEntitlements();
  for (const ent of expired) {
    await expireEntitlement(ent.id);
    if (ent.telegram_user_id) {
      const chatId = process.env.TELEGRAM_VIP_CHAT_ID;
      const bot = getBot();
      if (bot && chatId && chatId !== 'YOUR_CHAT_ID_HERE') {
        await kickUser(bot, chatId, ent.telegram_user_id);
      }
    }
  }
  return expired.length;
}

function startExpirationRoutine() {
  setInterval(() => {
    runExpiration().catch((error) => console.error('Erro na rotina de expiração:', error.name));
  }, 60 * 1000); // Roda a cada 1 minuto
}

/**
 * Em serverless não existe processo vivo para o setInterval acima, então a
 * mesma rotina precisa ser chamada de fora (Vercel Cron). O endpoint só existe
 * quando CRON_SECRET está definida, e exige esse segredo.
 */
if (process.env.CRON_SECRET) {
  app.get('/api/jobs/expire', async (req, res) => {
    const provided = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1] || req.get('x-cron-secret');
    if (!provided || !matches(provided, hash(process.env.CRON_SECRET))) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
    try {
      return res.json({ expired: await runExpiration() });
    } catch (error) {
      console.error('Cron expiration failed:', error.name);
      return res.status(500).json({ error: 'Erro na expiração.' });
    }
  });
}

// Tratador de erros (inclui a rejeição de origem pelo CORS)
app.use((err, req, res, next) => {
  if (err && /Origem não permitida/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }
  console.error('Erro não tratado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
});

/**
 * Inicialização única.
 *
 * Na Vercel não existe startServer(): cada invocação importa o app e chama
 * ready(). Memoizado para não reabrir o banco a cada requisição.
 */
let initialization = null;
function ready() {
  if (!initialization) {
    initialization = (async () => {
      // Pagamento mal configurado derruba só o checkout (503), nunca o site inteiro.
      if (paymentProvider.configuration) {
        try { paymentProvider.configuration(); }
        catch (error) { console.error('[pagamento] checkout indisponível: ' + error.message); }
      }
      console.log(`🖼️  Mídia VIP: driver ${vipMedia.assertConfigured()}.`);
      await initDb();
      console.log(`📦 Banco de dados inicializado (${require('./db/database').driver}).`);

      // Traz o feed antigo para o banco na primeira vez, para TODA publicação
      // ficar editável pelo painel. Roda uma vez só e nunca sobrescreve edição.
      try {
        const adopted = await vipPosts.adoptLegacyOnce();
        if (adopted.switched) console.log(`📥 ${adopted.imported} publicação(ões) do feed antigo importadas para vip_posts.`);
        // A adoção acontece depois do initDb, então a mídia dessas publicações
        // vira item do carrossel aqui — e não só no próximo boot.
        const itens = await require('./db/content-migrations').backfillMedia(await getDb());
        if (itens) console.log(`🖼️  ${itens} mídia(s) viraram item do carrossel.`);
      } catch (error) {
        console.warn('📥 Importação do feed antigo não concluída:', error.message);
      }

      // Vagas do feed ainda sem arquivo: aparecem aqui, não quebram a página.
      const faltando = vipMedia.driverName() === 'local'
        ? vipContent.posts
          .filter((post) => post.type !== 'cta' && !post.draft && !vipMedia.exists(post.source))
          .map((post) => post.source)
        : [];
      if (faltando.length) {
        console.warn(`🖼️  ${faltando.length} mídia(s) do feed VIP ainda não existem e ficarão ocultas:`);
        for (const source of faltando) console.warn(`     - ${source}`);
      }
    })().catch((error) => { initialization = null; throw error; });
  }
  return initialization;
}

// Inicialização
async function startServer() {
  await ready();

  if (process.env.ENABLE_TELEGRAM_BOT === 'true') initBot();

  startExpirationRoutine();

  return app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Simular pagamento: POST http://localhost:${PORT}/api/dev/orders/:orderId/pay`);
    }
  });
}

// Encerramento limpo (para o long-polling do bot antes de sair)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nRecebido ${signal}, encerrando...`);
    stopBot();
    process.exit(0);
  });
}

if (require.main === module) startServer().catch((error) => {
  console.error('Falha ao iniciar o servidor:', error);
  process.exit(1);
});

module.exports = { app, startServer, ready, runExpiration };
