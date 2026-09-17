// Confirmação de idade por sessão; não concede acesso ao conteúdo VIP.
let resolveAgeReady;
window.ageReady = new Promise(resolve => { resolveAgeReady = resolve; });
(function ageConfirmation() {
  const gate = document.getElementById('ageGate');
  let entered = false;
  function enter() {
    if (entered) return;
    entered = true;
    gate.hidden = true;
    document.body.classList.remove('age-pending');
    resolveAgeReady();
  }
  // A tela 18+ já pode ter sido confirmada pelo script embutido no HTML
  // (ele responde antes deste arquivo chegar). sessionStorage pode estar
  // bloqueado, então a marca global também vale.
  let confirmed = window.__ageOk === true;
  try { confirmed = confirmed || sessionStorage.getItem('ayla.age.confirmed') === 'yes'; } catch (_) {}
  if (confirmed) enter();
  else document.getElementById('ageConfirm').focus();
  document.getElementById('ageConfirm').addEventListener('click', () => {
    try { sessionStorage.setItem('ayla.age.confirmed', 'yes'); } catch (_) {}
    enter(); document.querySelector('.logo-text')?.focus();
  });
  document.getElementById('ageExit').addEventListener('click', () => window.location.replace('about:blank'));
  gate.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const first = document.getElementById('ageConfirm'), last = document.getElementById('ageExit');
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
})();

/* ===========================
   DATA: Creator & Content
   =========================== */

// Profile data comes exclusively from /api/profile.

const plans = [
  { id: "ayla_monthly",     label: "Assinatura mensal",      price: "R$ 9,90",  displayBtn: "Assinar agora R$ 9,90" },
  { id: "ayla_quarterly",   label: "3 meses",       price: "R$ 19,90" },
  { id: "ayla_semester",    label: "6 meses",       price: "R$ 29,90" }
];

// Viewer count – to be replaced by backend value
const viewerCount = 70;

// Offer expiry – feed a real timestamp from backend later
const offerExpiresAt = null; // e.g. new Date(Date.now() + 57000)

/* ===========================
   INIT: Populate DOM from data
   =========================== */
/**
 * Número curto para os contadores do perfil: 999, 1K, 5.2K, 27K, 27.4K, 1M.
 *
 * Abaixo de mil mostra o número inteiro. Acima, corta em mil/milhão com uma
 * casa decimal só quando ela existe, para o valor caber no celular de 320px
 * sem quebrar a linha de estatísticas.
 */
function compactNumber(value) {
  const texto = String(value ?? '').trim();
  // Valor já escrito à mão ("12,8 mil"): respeita como está.
  if (/[a-zA-Z]/.test(texto)) return texto;
  const number = Number(texto.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(number)) return String(value ?? '');
  const sign = number < 0 ? '-' : '';
  const abs = Math.abs(number);
  if (abs < 1000) return sign + String(Math.round(abs));
  for (const [limit, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (abs < limit) continue;
    const scaled = abs / limit;
    const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    return sign + String(rounded).replace('.', ',') + suffix;
  }
  return sign + String(Math.round(abs));
}

function applyProfile(profile) {
  const text = (id, value) => { const el = document.getElementById(id); if (el && value != null) el.textContent = value; };
  text('profileName', profile.name);
  document.querySelectorAll('[data-profile-avatar]').forEach(el => { el.src = profile.avatar; el.alt = profile.name; AylaFrame.apply(el,profile.avatarCrop,{role:"avatar"}); });
  document.getElementById('coverImg').src = profile.cover;
  AylaFrame.apply(document.getElementById('coverImg'),profile.coverCrop,{role:'cover',box:document.querySelector('.cover-wrap')});
  text('profileUsername', profile.username);
  text('profileBio', profile.bio);
  text('checkoutCreatorName', profile.name);
  text('checkoutCreatorUser', profile.username);
  document.querySelectorAll('.dynamic-post-name').forEach(el => el.textContent = profile.name);
  document.querySelectorAll('.dynamic-post-username').forEach(el => el.textContent = profile.username);

  const stats = profile.stats;
  if (stats) {
    text('statPhotos', compactNumber(stats.photos));
    text('statVideos', compactNumber(stats.videos));
    text('statLikes', compactNumber(stats.likes));
    text('statLocked', compactNumber(stats.posts));
    // Os números vêm do backend (conteúdo real + base histórica do perfil).
    text('tabPostsLabel', `${compactNumber(stats.posts)} Postagens`);
    text('tabMediaLabel', `${compactNumber(Number(stats.photos) + Number(stats.videos))} Mídias`);
  }

  const location = document.getElementById('profileLocation');
  if (location) {
    const value = profile.location || '';
    document.getElementById('profileLocationText').textContent = value || '';
    location.hidden = !value;
  }

  const viewers = document.getElementById('viewerCountEl');
  if (viewers) viewers.textContent = viewerCount + ' assistindo agora';
}


/**
 * Feed bloqueado da HOME.
 *
 * Duas origens, mesma marcação e mesmo CSS:
 *  - estática: os blocos já escritos no index.html (prévias pré-renderizadas);
 *  - gerenciada: as publicações marcadas em /admin como "prévia na HOME".
 *
 * Em nenhuma das duas a mídia original chega ao visitante. O que ele recebe é
 * uma derivada minúscula; o arquivo pago continua atrás do link assinado.
 *
 * As legendas abaixo são de apresentação. Nenhuma contagem de curtidas é
 * exibida aqui: números simulados não devem parecer engajamento real.
 */
const HOME_CAPTIONS = Array(7).fill('Prévia ilustrativa — mídia da Ayla ainda não cadastrada.');
/**
 * TEASER DE VÍDEO BLOQUEADO.
 *
 * O que toca aqui NÃO é o vídeo da área VIP. É um arquivo derivado servido por
 * `/api/home/preview-video/<id>`: poucos segundos, resolução baixa, sem faixa
 * de áudio e com o desfoque já gravado dentro dele. O original nunca chega a
 * este navegador — nem por link assinado, nem por caminho de Storage.
 *
 * O que esta função faz é só o comportamento de tela:
 *   toca a derivada sem som em loop enquanto estiver visível.
 *
 * `preload="metadata"` de propósito: no celular, nada de baixar o arquivo
 * inteiro antes da pessoa olhar para ele.
 */
function mountTeaser(locked, { src, seconds, poster, overlay }) {
  // O convite do teaser fala do vídeo, não de "este conteúdo" genérico.
  if (overlay) {
    const title = overlay.querySelector('.locked-text');
    if (title) {
      title.textContent = 'Conteúdo exclusivo';

    }
  }
  const video = document.createElement('video');
  video.className = 'locked-video';
  video.dataset.teaserSrc = src;
  video.muted = true; video.defaultMuted = true; video.volume = 0;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'none';
  // Uma passada só: a prévia vai até o limite e o cartão volta ao estado
  // bloqueado (pôster desfocado + convite). Nada de loop infinito consumindo
  // bateria e dados enquanto a pessoa lê o resto da página.
  video.loop = false;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
  if (poster) video.poster = poster;

  const replay = document.createElement('button');
  replay.type = 'button';
  replay.className = 'locked-replay';
  replay.textContent = '▶ Ver prévia';
  replay.setAttribute('aria-label', 'Reproduzir prévia do vídeo');

  // Only the already blurred, silent derivative plays; originals stay private.
  let visible = false;
  let finished = false;
  // Trava do lado do cliente, além da duração do próprio arquivo derivado.
  const limit = Number(seconds) > 0 ? Number(seconds) : 7;
  const play = () => {
    if (!video.getAttribute('src')) video.src = video.dataset.teaserSrc;
    return video.play().then(() => { replay.hidden = true; }).catch(() => { replay.hidden = false; });
  };
  // Fim da prévia: volta ao cartão bloqueado, com o convite de rever.
  const finish = () => {
    finished = true;
    video.pause();
    try { video.currentTime = 0; } catch (_) { /* alguns navegadores recusam */ }
    locked.classList.remove('teaser-ready');
    replay.hidden = false;
  };
  video.addEventListener('timeupdate', () => { if (video.currentTime >= limit) finish(); });
  video.addEventListener('ended', finish);
  replay.addEventListener('click', event => { event.stopPropagation(); finished = false; play(); });
  video.addEventListener('loadeddata', () => { locked.classList.add('teaser-ready'); });
  video.addEventListener('playing', () => { locked.classList.add('teaser-ready'); replay.hidden = true; });
  video.addEventListener('error', () => { locked.classList.remove('teaser-ready'); replay.hidden = false; });
  // Fetch the small derivative shortly before arrival, without playing offscreen.
  const warmup = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      if (!video.getAttribute('src')) { video.preload = 'auto'; video.src = video.dataset.teaserSrc; video.load(); }
      warmup.disconnect();
    }
  }, { rootMargin: '450px 0px' });
  warmup.observe(video);
  const resume = () => {
    if (finished) { video.pause(); return; }
    if (visible && !document.hidden && !document.body.classList.contains('age-pending')) play();
    else video.pause();
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) { visible = entry.isIntersecting && entry.intersectionRatio >= .25; resume(); }
  }, { threshold: [0, .25] });
  observer.observe(video);
  document.addEventListener('visibilitychange', resume);
  document.getElementById('ageConfirm')?.addEventListener('click', resume, { once: true });

  // O vídeo entra ATRÁS do véu e do convite; o botão de rever, na frente.
  if (overlay && overlay.parentNode === locked) locked.insertBefore(video, overlay);
  else locked.append(video);
  locked.append(replay);
  return video;
}

/**
 * Este item do carrossel pode aparecer para um visitante?
 *
 * Só se ele trouxer a PRÓPRIA derivada: a amostra minúscula embutida (foto) ou
 * o endereço da rota de teaser (vídeo). Não existe caminho "senão mostra o
 * original" — item sem derivada some da lista e pronto.
 */
function isSafePreviewItem(item) {
  if (!item) return false;
  const foto = typeof item.preview === 'string' && item.preview.startsWith('data:image/jpeg;base64,');
  const video = typeof item.teaser === 'string' && item.teaser.startsWith('/api/home/preview-video/');
  return foto || video;
}

/**
 * O carrossel bloqueado da HOME.
 *
 * Reaproveita o cartão que já existe: a moldura, o véu, o cadeado e o CTA
 * continuam exatamente onde estavam — o que muda é que agora há mais de uma
 * derivada para deslizar por baixo deles.
 */
function mountLockedCarousel(locked, overlay, items, teaserSeconds) {
  // O pôster e o teaser do primeiro item já foram montados por fora; o
  // carrossel reconstrói tudo em células para poder deslizar.
  locked.querySelectorAll('.locked-img, .locked-video, .locked-replay').forEach(node => node.remove());
  locked.classList.remove('has-teaser');

  AylaCarousel.build(locked, items.map((item, index) => (cell) => {
    cell.classList.add('locked-cell');
    const image = document.createElement('img');
    image.className = 'locked-img';
    image.src = item.preview || '';
    image.alt = item.type === 'video' ? 'Prévia desfocada de um vídeo exclusivo' : 'Prévia desfocada de uma foto exclusiva';
    image.loading = index === 0 ? 'eager' : 'lazy';
    image.width = 64; image.height = 80;
    cell.append(image);
    AylaFrame.apply(image, item.crop, { box: cell, preview: true });
    if (item.type === 'video' && typeof item.teaser === 'string' && item.teaser.startsWith('/api/home/preview-video/')) {
      cell.classList.add('has-teaser');
      const video = mountTeaser(cell, { src: API_BASE + item.teaser, seconds: teaserSeconds, poster: item.preview, overlay: null });
      AylaFrame.apply(video, item.crop, { box: cell, preview: true });
    }
  }), {
    onEnter: video => { video.play?.().catch(() => {}); }
  });
  // O véu e o CTA ficam por cima de todos os slides, não dentro de um deles.
  locked.append(overlay);
}

function decorateLockedPost(post, { type, caption, id, likes_count }) {
  const head = post.previousElementSibling;
  const article = document.createElement('article');
  article.className = 'preview-post';
  article.dataset.type = type;
  // Só serve para o modo administrador casar o cartão com o registro certo.
  if (id != null) article.dataset.postId = String(id);
  post.parentNode.insertBefore(article, head);
  article.append(head);
  const captionEl = document.createElement('p');
  captionEl.className = 'preview-caption'; captionEl.textContent = caption;
  // Sem etiqueta de FOTO/VÍDEO e sem faixa sobre a mídia: o feed fica limpo.
  head.querySelector('.post-menu')?.remove();
  article.append(captionEl, post);
  const actions = document.createElement('div');
  actions.className = 'preview-actions';
  const shapes = [
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z',
    'M21 11.5a9 9 0 0 1-9 9 10 10 0 0 1-4-.9L3 21l1.4-4.8A9 9 0 1 1 21 11.5z',
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M15 8.5c-1-1-5-1.5-5 1s5 1 5 4c0 2.5-4 2.5-6 1 M12 6v12'
  ];
  ['Curtidas disponíveis no VIP', 'Comentários indisponíveis'].forEach((label, index) => {
    const control = document.createElement('button');
    control.type = 'button'; control.className = 'preview-action';
    control.title = label; control.setAttribute('aria-label', label);
    control.disabled = index < 2;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', shapes[index]); svg.append(shape); control.append(svg);
    actions.append(control);
  });
  article.append(actions);
  const footer = document.createElement('div');
  footer.className = 'preview-engagement';
  const left = document.createElement('span');
  left.textContent = Number.isFinite(likes_count) ? likes_count.toLocaleString('pt-BR') + ' curtidas' : 'Conteúdo exclusivo';
  if (Number.isFinite(likes_count)) left.setAttribute('aria-label', likes_count + ' curtidas');
  const note = document.createElement('span'); note.textContent = 'Só para assinantes';
  footer.append(left, note); article.append(footer);
  return article;
}
(function polishHomeFeed() {
  document.querySelectorAll('.locked-post').forEach((post, index) => {
    decorateLockedPost(post, { type: index === 0 ? 'image' : 'video', caption: HOME_CAPTIONS[index] });
  });
})();

/* ===========================
   MODAL HELPERS
   =========================== */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.returnFocus = document.activeElement;
    el.classList.add('open'); document.body.style.overflow = 'hidden';
    el.querySelector('button, input, a[href]')?.focus({ preventScroll: true });
  }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    const wasOpen = el.classList.contains('open');
    el.classList.remove('open'); document.body.style.overflow = '';
    if (wasOpen && el.returnFocus?.isConnected) el.returnFocus.focus({ preventScroll: true });
  }
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      if (overlay.id === 'checkoutModalOverlay') return closeCheckout();
      closeModal(overlay.id);
    }
  });
});

/* ===========================
   CHECKOUT & PIX INTEGRATION
   =========================== */
let currentPollingInterval = null;
let currentOrderId = null;
let currentCheckoutToken = null;
let checkoutVersion = 0;
let selectedProduct = null;
let checkoutBusy = false;
let currentCreationTimer = null;
let catalog = null;
const API_BASE = location.protocol === 'file:' || (['localhost','127.0.0.1'].includes(location.hostname) && ['5500','5501'].includes(location.port)) ? 'http://localhost:3333' : '';
const PRODUCT_ALIASES = { 'broadcast-access': 'ayla_monthly', 'private-contact': 'ayla_whatsapp_unlock', 'chat-unlock': 'ayla_whatsapp_unlock' };
function authHeaders() { return { Authorization: 'Bearer ' + currentCheckoutToken }; }
function checkoutToken(product) {
  const key = 'ayla.checkout.' + product;
  let token;
  try { token = sessionStorage.getItem(key); } catch (_) {}
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    try { sessionStorage.setItem(key, token); } catch (_) {}
  }
  return token;
}
function savedPendingPix(productId = selectedProduct, token = null) {
  return AylaCheckouts.list().find(item => item.productId === productId && (!token || item.token === token)) || null;
}
async function pendingPixStatus(pending) {
  const response = await fetch(API_BASE + '/api/orders/' + encodeURIComponent(pending.payment.orderId) + '/status', {
    headers: { Authorization: 'Bearer ' + pending.token }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Não foi possível consultar o pagamento agora.');
  return response.json();
}
function openPaidAccount(pending, needsClaim) {
  if (needsClaim) AylaCheckouts.select(pending);
  else AylaCheckouts.remove(pending);
  location.assign(needsClaim ? '/criar-acesso?order=' + encodeURIComponent(pending.payment.orderId) : '/meu-acesso');
}
let pixTimer=null;const pendingSeen=new Set();const priorPending=new Set((window.AylaCheckouts?.list()||[]).map(x=>x.payment?.orderId).filter(Boolean));
function startPixTimer(expiresAt,version,token){clearInterval(pixTimer);const target=document.getElementById('pixExpiry');const ms=expiresAt?Date.parse(String(expiresAt).replace(' ','T')+(String(expiresAt).includes('Z')?'':'Z')):NaN;
 if(!Number.isFinite(ms)){target.textContent='Prazo não informado pela operadora';return;}
 const tick=()=>{if(version!==checkoutVersion){clearInterval(pixTimer);return;}const left=Math.max(0,Math.ceil((ms-Date.now())/1000));target.textContent=left?('Tempo restante: '+String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0')):'Prazo encerrado';if(!left){clearInterval(pixTimer);window.FunnelAnalytics?.track('pix_expired',selectedProduct,currentOrderId);showRegenerate(true,selectedProduct);}};tick();pixTimer=setInterval(tick,1000);
}
function showRegenerate(enabled,productId){const fresh=document.getElementById('pixRegenerate'),small=document.getElementById('pixSmallerPlan');if(!fresh)return;fresh.hidden=!enabled;small.hidden=!enabled||['monthly','ayla_monthly','whatsapp_unlock','ayla_whatsapp_unlock'].includes(productId);fresh.onclick=()=>location.assign('/continuar?order='+encodeURIComponent(currentOrderId)+'&regen=1');small.onclick=()=>location.assign('/continuar?order='+encodeURIComponent(currentOrderId)+'&smaller=1');}
let pendingNoticeVersion = 0;
let pendingNoticeTimer = null;
function updatePendingNoticeCountdown() {
  clearInterval(pendingNoticeTimer);
  const nodes = [...document.querySelectorAll('[data-pix-expires]')];
  if (!nodes.length) return;
  const tick = () => {
    let finished = false;
    for (const node of nodes) {
      const seconds = Math.max(0, Math.ceil((Number(node.dataset.pixExpires) - Date.now()) / 1000));
      node.textContent = seconds ? 'Restam ' + String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : 'Prazo encerrado';
      if (!seconds) finished = true;
    }
    if (finished) { clearInterval(pendingNoticeTimer); refreshPendingPixNotice(); }
  };
  tick();
  if (!nodes.some(node => Date.now() >= Number(node.dataset.pixExpires))) pendingNoticeTimer = setInterval(tick, 1000);
}
async function refreshPendingPixNotice() {
  const notice = document.getElementById('pendingPixNotice');
  const version = ++pendingNoticeVersion;
  const items = AylaCheckouts.list();
  if (!items.length) { notice.hidden = true; notice.replaceChildren(); return; }
  const states = await Promise.all(items.map(async item => {
    try { return { item, state: item.payment?.orderId ? await pendingPixStatus(item) : { status: 'CREATING' } }; }
    catch (_) { return { item, state: { status: 'UNKNOWN' } }; }
  }));
  if (version !== pendingNoticeVersion) return;
  const wasOpen = notice.open;
  notice.replaceChildren();
  const summary = document.createElement('summary');
  summary.textContent = 'Compras recentes'; notice.append(summary);
  notice.open = wasOpen || location.hash === '#pendingPixNotice' || states.some(({state})=>state.status==='PENDING');
  const labels = { ayla_monthly: '1 mês', ayla_quarterly: '3 meses', ayla_semester: '6 meses', ayla_whatsapp_unlock: 'Contato WhatsApp' };
  for (const { item, state } of states) {
    if (!AylaCheckouts.list().some(saved => saved.token === item.token)) continue;
    if (state.status === 'PAID' && state.accountFlow && !state.needsClaim) { AylaCheckouts.remove(item); continue; }
    const paid = state.status === 'PAID';
    const showAll = location.hash === '#pendingPixNotice';
    const age = Date.now() - Number(item.createdAt || 0);
    if (!showAll && item.noticeDismissedAt && (!paid || item.noticeDismissedPaid)) continue;
    const row = document.createElement('div'); row.className = 'pending-pix-row';
    const text = document.createElement('span'), button = document.createElement('button'); button.type = 'button';
    if (notice.children.length === 1) { text.id = 'pendingPixText'; button.id = 'pendingPixContinue'; }
    let label = 'Compra em andamento';
    button.textContent = 'Retomar compra';
    button.onclick = () => item.payment?.orderId ? location.assign('/continuar?order='+encodeURIComponent(item.payment.orderId)) : openCheckout(item.productId,item.token);
    if (state.status === 'PENDING') { label = 'Você tem um PIX pendente'; button.textContent = 'Continuar pagamento'; }
    else if (state.status === 'PAID' && state.accountFlow) {
      label = 'Pagamento confirmado'; button.textContent = 'Criar meu acesso';
      button.onclick = () => openPaidAccount(item, true);
    } else if (state.requiresReview) { label = 'Pedido em verificação'; button.textContent = 'Verificar pedido'; }
    else if (['EXPIRED','CANCELED'].includes(state.status)) { label = 'Prazo do PIX encerrado'; button.textContent = 'Conferir pedido'; }
    text.textContent = label + ' · ' + labels[item.productId] + (Number.isFinite(Number(state.amount))?' · '+Number(state.amount).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}):'');if(state.status==='EXPIRED')window.FunnelAnalytics?.track('pix_expired',item.productId,item.payment?.orderId);if(state.status==='PENDING'&&item.payment?.orderId&&priorPending.has(item.payment.orderId)&&!pendingSeen.has(item.payment.orderId)){pendingSeen.add(item.payment.orderId);window.FunnelAnalytics?.track('pix_pending_return',item.productId,item.payment.orderId);}
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'pending-pix-dismiss';
    dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dispensar aviso de ' + labels[item.productId]);
    dismiss.onclick = () => { AylaCheckouts.save({ ...item, noticeDismissedAt: Date.now(), noticeDismissedPaid: paid }); refreshPendingPixNotice(); };
    row.append(text);
    if (state.status === 'PENDING') {
      const countdown = document.createElement('small');
      const expiry = state.expiresAt ? Date.parse(String(state.expiresAt).replace(' ', 'T') + 'Z') : NaN;
      if (Number.isFinite(expiry)) countdown.dataset.pixExpires = String(expiry);
      else countdown.textContent = 'Prazo não informado pela operadora';
      row.append(countdown);
    }
    row.append(button, dismiss); notice.append(row);
  }
  notice.hidden = notice.children.length <= 1;
  summary.textContent = notice.children.length===2 && states.some(({state})=>state.status==='PENDING')?'PIX pendente · Continuar pagamento':'Compras recentes (' + (notice.children.length - 1) + ')';
  updatePendingNoticeCountdown();
}
function checkoutError(message, retry, reference = null) {
  const loading = document.getElementById('pixLoadingState');
  loading.replaceChildren(); loading.style.display = 'flex';
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  const text = document.createElement('p'); text.textContent = message; loading.append(text);
  if (reference) { const code = document.createElement('small'); code.className = 'checkout-reference'; code.textContent = 'Pedido: ' + reference; loading.append(code); }
  if (retry) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-orange btn-pix';
    button.textContent = 'Tentar novamente'; button.onclick = retry; loading.append(button);
  }
}
async function openCheckout(productId, resumeToken = null) {
  if(!resumeToken){window.FunnelAnalytics?.track('plan_selected',productId);if(productId.includes('monthly')||productId.includes('quarterly')||productId.includes('semester'))window.FunnelAnalytics?.track('subscription_cta_click',productId);window.FunnelAnalytics?.track('checkout_started',productId);}
  closeCheckout();
  const version = checkoutVersion;
  selectedProduct = PRODUCT_ALIASES[productId] || productId;
  const saved = savedPendingPix(selectedProduct, resumeToken);
  currentCheckoutToken = saved?.token || checkoutToken(selectedProduct);
  currentOrderId = null;
  openModal('checkoutModalOverlay');
  document.getElementById('pixActiveArea').style.display = 'none';

  document.getElementById('pixStatusContainer').classList.remove('paid');
  document.getElementById('checkoutPlanLabel').textContent = 'Carregando...';
  document.getElementById('checkoutPlanPrice').textContent = '';
  checkoutError('Carregando checkout...');
  try {
    const response = await fetch(API_BASE + '/api/catalog', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Checkout indisponível. Tente novamente.');
    const data = await response.json();
    if (version !== checkoutVersion) return;
    catalog = data;
    const product = data.products.find(p => p.id === selectedProduct);
    if (!product) { checkoutError('Este produto ainda não está disponível para compra.'); return; }
    document.getElementById('checkoutPlanLabel').textContent = product.name;
    document.getElementById('checkoutPlanPrice').textContent = product.price.toLocaleString('pt-BR', {style:'currency',currency:'BRL'});
    const pending = saved;
    if (pending?.payment?.orderId) {
      const status = await pendingPixStatus(pending);
      if (version !== checkoutVersion) return;
      if (status.status === 'PAID' && status.accountFlow) { openPaidAccount(pending, status.needsClaim); return; }
      if (status.requiresReview || ['EXPIRED','CANCELED'].includes(status.status)) {
        checkoutError(status.requiresReview
          ? 'Seu pedido está em verificação. Não faça outro pagamento. Guarde esta referência para atendimento.'
          : 'Este PIX não está mais pendente. Se você pagou, aguarde a confirmação antes de fazer outro pagamento.', null, pending.payment.orderId);
        return;
      }
      if (status.status === 'PENDING') { const fresh=await fetch(API_BASE+'/api/orders/'+encodeURIComponent(pending.payment.orderId)+'/pix',{headers:{Authorization:'Bearer '+pending.token},signal:AbortSignal.timeout(10000)});if(fresh.ok){showBuyerPix(await fresh.json(),version,pending.token);return;} }
    }
    fetch(API_BASE+'/api/conversions/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:selectedProduct,checkoutToken:currentCheckoutToken}),signal:AbortSignal.timeout(5000)}).catch(()=>{});
    await createCheckoutPix(version);
  } catch (error) {
    if (version === checkoutVersion) checkoutError(error.message, () => openCheckout(productId, currentCheckoutToken));
  }
}
async function createCheckoutPix(version = checkoutVersion) {
  if (checkoutBusy || version !== checkoutVersion) return;
  checkoutBusy = true;
  const productId = selectedProduct;
  const token = currentCheckoutToken;
  checkoutError('Gerando QR Code PIX...');
  try {
    AylaCheckouts.save(savedPendingPix(productId, token) || { productId, token });
    const response = await fetch(API_BASE + '/api/payments/pix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ productId, checkoutToken: token })
    });
    const data = await response.json();
    if (data.orderId) {
      const old = savedPendingPix(productId, token);
      AylaCheckouts.save({ productId, token, payment: { ...old?.payment, ...data } });
    }
    refreshPendingPixNotice();
    if (version !== checkoutVersion) return;
    if (response.status === 202) {
      checkoutError('Seu PIX está sendo preparado. Você pode aguardar aqui ou retomar este pedido depois.');
      waitForPixCreation(data.orderId, version, token);
      return;
    }
    if (!response.ok) {
      checkoutError(data.error || 'Não foi possível consultar esta cobrança.',
        data.retryable === true ? () => createCheckoutPix(version) : null, data.requiresReview ? data.orderId : null);
      return;
    }
    AylaCheckouts.select(savedPendingPix(productId, token));
    showBuyerPix(data,version,token);
  } catch (error) {
    if(version===checkoutVersion) {
      const connectionError = ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name);
      checkoutError(connectionError
        ? 'A conexão demorou ou foi interrompida. Tente novamente para consultar a mesma cobrança com segurança.'
        : error.message, () => createCheckoutPix(version));
    }
  } finally { if(version===checkoutVersion)checkoutBusy=false; }
}
function waitForPixCreation(orderId, version, token) {
  clearTimeout(currentCreationTimer);
  currentCreationTimer = setTimeout(async () => {
    if (version !== checkoutVersion) return;
    try {
      const pending = AylaCheckouts.list().find(item => item.token === token);
      if (!pending) return;
      const state = await pendingPixStatus(pending);
      if (version !== checkoutVersion) return;
      if (state.status === 'PAID' && state.accountFlow) { openPaidAccount(pending, state.needsClaim); return; }
      if (state.status === 'PENDING' || state.retryable) { createCheckoutPix(version); return; }
      if (state.requiresReview || state.status !== 'CREATING') {
        checkoutError('Seu pedido está em verificação. Não faça outro pagamento. Guarde esta referência para atendimento.', null, orderId);
        refreshPendingPixNotice(); return;
      }
    } catch (_) {
      if (version !== checkoutVersion) return;
      checkoutError('A conexão foi interrompida. Vamos consultar o mesmo pedido novamente.');
    }
    waitForPixCreation(orderId, version, token);
  }, 3000);
}
function showBuyerPix(data,version,token){

    currentOrderId = data.orderId;
    document.getElementById('pixCodeInput').value = data.pix.copyPaste;
    const qr = document.getElementById('pixQrImage'); qr.src = data.pix.qrCode; qr.style.display = 'block';
    document.getElementById('pixLoadingState').style.display = 'none';
    document.getElementById('pixActiveArea').style.display = 'block';
    const copy = document.getElementById('btnCopyPix'); copy.disabled = false; copy.textContent = 'COPIAR PIX'; copy.classList.remove('copied');
    document.getElementById('pixMockNotice').hidden = !data.mock;
    const stagingButton=document.getElementById('stagingConfirm');stagingButton.hidden=!data.staging;
    if(data.staging){const btn=stagingButton;btn.disabled=false;btn.textContent='SIMULAR PAGAMENTO — STAGING';btn.onclick=async()=>{btn.disabled=true;try{const r=await fetch('/api/staging/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:data.orderId,claimToken:token})});if(!r.ok)throw Error();}catch(_){btn.disabled=false;btn.textContent='Tentar simulação novamente';}};}
    document.getElementById('pixStatusMessage').textContent = 'Aguardando pagamento... não precisa atualizar';
    startPixTimer(data.expiresAt,version,token);window.showPushOffer?.();window.FunnelAnalytics?.track('pix_qr_viewed',selectedProduct,data.orderId);
    startPaymentStatusPolling(data.orderId, version, token);
}
function startPaymentStatusPolling(orderId, version, token) {
  clearTimeout(currentPollingInterval);
  async function poll() {
    if (version !== checkoutVersion) return;
    try {
      const response = await fetch(API_BASE + '/api/orders/' + orderId + '/status', { headers: {Authorization:'Bearer '+token}, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Consulta indisponível');
      const data = await response.json();
      if (version !== checkoutVersion) return;
      const message = document.getElementById('pixStatusMessage');
      if(data.status==='PAID' && data.accountFlow){
        currentPollingInterval=null;
        const pending = AylaCheckouts.list().find(item => item.token === token);
        if (pending) openPaidAccount(pending, data.needsClaim);
        return;
      }
      if (['EXPIRED','CANCELED','FAILED'].includes(data.status)) {
        // Keep the claim: a delayed valid webhook may still confirm this order.
        message.textContent = data.requiresReview ? 'Pedido em verificação. Não faça outro pagamento.' : 'PIX indisponível. Se você pagou, aguarde a confirmação.';
        document.getElementById('btnCopyPix').disabled = true;
        currentPollingInterval = null;if(data.status==='EXPIRED')window.FunnelAnalytics?.track('pix_expired',selectedProduct,orderId);showRegenerate(data.status==='EXPIRED'||data.status==='CANCELED',selectedProduct);refreshPendingPixNotice(); return;
      }
      message.textContent = 'Aguardando pagamento... não precisa atualizar';
    } catch (_) {
      if (version !== checkoutVersion) return;
      document.getElementById('pixStatusMessage').textContent = 'Sem conexão. Consultando novamente...';
    }
    if (version === checkoutVersion) currentPollingInterval = setTimeout(poll, 3000);
  }
  poll();
}
function closeCheckout() {
  checkoutVersion++; checkoutBusy = false;
  clearTimeout(currentCreationTimer); currentCreationTimer = null;
  clearTimeout(currentPollingInterval); currentPollingInterval = null;clearInterval(pixTimer);pixTimer=null;
  closeModal('checkoutModalOverlay');
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCheckout(); });
window.addEventListener('pagehide', closeCheckout);

/* ===========================
   LIVE BADGE → Live Modal
   =========================== */
document.getElementById('avatarLive')?.addEventListener('click', () => openCheckout('ayla_monthly'));
document.getElementById('closeLiveModal')?.addEventListener('click', () => closeModal('liveModalOverlay'));
document.getElementById('btnLiveJoin')?.addEventListener('click', () => {
  closeModal('liveModalOverlay');
  openCheckout('broadcast-access');
});

/* ===========================
   FLOATING WHATSAPP → Contact Modal
   =========================== */
const btnSubscribeNow = document.getElementById('btnSubscribeNow');
if (btnSubscribeNow) btnSubscribeNow.addEventListener('click', () => openCheckout('ayla_monthly'));

const btnPlan1m = document.getElementById('btnPlan1m');
if (btnPlan1m) btnPlan1m.addEventListener('click', () => openCheckout('ayla_monthly'));

const btnPlan3m = document.getElementById('btnPlan3m');
if (btnPlan3m) btnPlan3m.addEventListener('click', () => openCheckout('ayla_quarterly'));

const btnPlan6m = document.getElementById('btnPlan6m');
if (btnPlan6m) btnPlan6m.addEventListener('click', () => openCheckout('ayla_semester'));

// Promo section toggle
const promoToggle = document.getElementById('promoToggle');
const promoContent = document.getElementById('promoPlansContent');
if (promoToggle && promoContent) {
  promoToggle.addEventListener('click', () => {
    promoToggle.classList.toggle('closed');
    promoContent.classList.toggle('closed');
  });
  promoToggle.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); promoToggle.click(); }
  });
}

// Delegado: as prévias gerenciadas em /admin entram no DOM depois daqui.
document.addEventListener('click', event => {
  if (event.target.closest('.btn-unlock')) openCheckout('ayla_monthly');
});

// Perfil público
(async function loadProfile() {
  try {
    let changed = false;
    try { changed = sessionStorage.getItem('ayla.profile.changed') === '1'; sessionStorage.removeItem('ayla.profile.changed'); } catch (_) {}
    const response = await fetch(API_BASE + '/api/profile', { cache: changed ? 'reload' : 'default', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Perfil indisponível');
    const profile = await response.json();
    if (profile && typeof profile.name === 'string') applyProfile(profile);
  } catch (_) { document.getElementById('profileBio').textContent = 'Não foi possível carregar o perfil. Atualize a página.'; }
})();



/**
 * Troca as prévias estáticas pelas publicações marcadas em /admin.
 *
 * Falha em silêncio de propósito: sem backend, sem posts marcados ou com erro
 * de rede, a página continua exatamente como está no HTML. A amostra vem
 * pronta do servidor como imagem minúscula — não existe caminho de mídia aqui.
 */
(async function loadManagedPreviews() {
  await window.ageReady;
  // Feed em páginas: o visitante recebe as primeiras prévias e o resto chega
  // ao chegar perto do fim. Menos bytes e menos vídeos no primeiro desenho.
  const PAGE = 6;
  const anchor = document.querySelector('#contentTabs .tabs-bar');
  const existing = [...document.querySelectorAll('.preview-post')];
  const blueprint = existing[0]?.querySelector('.post-header');
  const overlayModel = document.querySelector('.locked-overlay')?.innerHTML || '';
  if (!blueprint || !anchor) return;

  let rendered = 0;
  let total = 0;
  let carregando = false;
  let sentinela = null;

  async function buscar(offset) {
    const response = await fetch(`${API_BASE}/api/home/previews?limit=${PAGE}&offset=${offset}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('previews');
    const data = await response.json();
    return { previews: Array.isArray(data.previews) ? data.previews : [], total: Number(data.total) || 0, managed: data.source === 'managed' };
  }

  function montar(previews) {
    const fragment = document.createDocumentFragment();
    const usados = [];
    previews.forEach((item, index) => {
      if (!item || typeof item.preview !== 'string' || !item.preview.startsWith('data:image/jpeg;base64,')) return;
      const header = blueprint.cloneNode(true);
      header.querySelector('.post-type')?.remove();
      const locked = document.createElement('div');
      locked.className = 'locked-post';
      const image = document.createElement('img');
      image.className = 'locked-img';
      image.src = item.preview;
      image.alt = item.type === 'video' ? 'Prévia desfocada de um vídeo exclusivo' : 'Prévia desfocada de uma foto exclusiva';
      // Só a primeira prévia da PRIMEIRA página entra como prioritária.
      image.loading = rendered === 0 && index === 0 ? 'eager' : 'lazy';
      image.decoding = 'async';
      image.width = 64; image.height = 80;
      const overlay = document.createElement('div');
      overlay.className = 'locked-overlay';
      overlay.innerHTML = overlayModel;
      locked.append(image, overlay);
      AylaFrame.apply(image, item.crop, { box: locked, preview: true });
      // Vídeo com teaser derivado: o <video> entra por cima do pôster, que fica
      // atrás como primeiro quadro e como plano B se o autoplay for bloqueado.
      if (item.type === 'video' && typeof item.teaser === 'string' && item.teaser.startsWith('/api/home/preview-video/')) {
        locked.classList.add('has-teaser');
        const video = mountTeaser(locked, { src: API_BASE + item.teaser, seconds: item.teaserSeconds, poster: item.preview, overlay });
        AylaFrame.apply(video, item.crop, { box: locked, preview: true });
      }
      // Carrossel bloqueado: só entram itens que trazem a SUA derivada segura —
      // a amostra minúscula da foto ou a rota do teaser do vídeo. Item sem
      // derivada simplesmente não vira slide; o original nunca é alternativa.
      const safe = Array.isArray(item.items) ? item.items.filter(isSafePreviewItem) : [];
      if (safe.length > 1) mountLockedCarousel(locked, overlay, safe, item.teaserSeconds);
      fragment.append(header, locked);
      usados.push(item);
    });
    return { fragment, usados };
  }

  function decorar(usados) {
    const cards = [...document.querySelectorAll('.locked-post')];
    usados.forEach((item, index) => {
      const post = cards[rendered + index];
      if (!post) return;
      decorateLockedPost(post, {
        id: item.id, likes_count: item.likes_count,
        type: item.type === 'video' ? 'video' : 'image',
        caption: item.caption || HOME_CAPTIONS[(rendered + index) % HOME_CAPTIONS.length]
      });
    });
  }

  async function pagina(offset) {
    if (carregando) return;
    carregando = true;
    try {
      const data = await buscar(offset);
      total = data.total || data.previews.length;
      if (offset === 0 && data.previews.length === 0) {
        if (data.managed) existing.forEach(post => post.remove());
        return;
      }
      const { fragment, usados } = montar(data.previews);
      if (!fragment.childNodes.length) return;
      if (offset === 0) { existing.forEach(article => article.remove()); anchor.after(fragment); }
      else { (sentinela || [...document.querySelectorAll('.locked-post')].pop())?.before(fragment); }
      decorar(usados);
      rendered += usados.length;
    } finally { carregando = false; }
  }

  await pagina(0).catch(() => {});
  if (!rendered || rendered >= total) return;

  // Próxima página só quando o visitante chega perto do fim do que já existe.
  sentinela = document.createElement('div');
  sentinela.className = 'feed-sentinela';
  sentinela.setAttribute('aria-hidden', 'true');
  [...document.querySelectorAll('.locked-post')].pop()?.after(sentinela);
  const observer = new IntersectionObserver(async entries => {
    if (!entries.some(entry => entry.isIntersecting) || carregando) return;
    await pagina(rendered).catch(() => {});
    if (rendered >= total) { observer.disconnect(); sentinela.remove(); }
  }, { rootMargin: '600px 0px' });
  observer.observe(sentinela);
})();

/* ===========================
   CHECKOUT CLOSE & PIX ACTIONS
   =========================== */
document.getElementById('closeCheckoutModal')?.addEventListener('click', closeCheckout);

document.getElementById('btnCopyPix')?.addEventListener('click', async () => {
  const input = document.getElementById('pixCodeInput');
  if (input && input.value) {
    try {
      await navigator.clipboard.writeText(input.value);window.FunnelAnalytics?.track('pix_copied',selectedProduct,currentOrderId);
    } catch (e) {
      input.select();
      if(document.execCommand('copy'))window.FunnelAnalytics?.track('pix_copied',selectedProduct,currentOrderId);
    }
    const btn = document.getElementById('btnCopyPix');
    if (btn) {
      btn.textContent = 'Copiado! ✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'COPIAR PIX';
        btn.classList.remove('copied');
      }, 2500);
    }
  }
});

/* ===========================
   CONTENT TABS
   =========================== */
document.getElementById('tab1').addEventListener('click', () => {
  document.getElementById('contentTabs').classList.remove('media-grid');
  document.getElementById('tab1').setAttribute('aria-pressed', 'true');
  document.getElementById('tab2').setAttribute('aria-pressed', 'false');
  document.getElementById('tab1').classList.add('active');
  document.getElementById('tab2').classList.remove('active');
});
document.getElementById('tab2').addEventListener('click', () => {
  document.getElementById('contentTabs').classList.add('media-grid');
  document.getElementById('tab1').setAttribute('aria-pressed', 'false');
  document.getElementById('tab2').setAttribute('aria-pressed', 'true');
  document.getElementById('tab2').classList.add('active');
  document.getElementById('tab1').classList.remove('active');
});

/* ===========================
   BIO: Read more / less
   =========================== */
// Uma bio só: recolhida em três linhas pelo CSS e aberta por aqui. Assim não
// existe uma versão curta que possa ficar diferente da do /vip.
let bioExpanded = false;
document.getElementById('readMoreBtn').addEventListener('click', () => {
  bioExpanded = !bioExpanded;
  document.getElementById('profileBio').classList.toggle('expanded', bioExpanded);
  document.getElementById('readMoreBtn').textContent = bioExpanded ? 'Ler menos' : 'Ler mais';
});

/* ===========================
   FLOATING BUTTONS: Desktop position
   =========================== */
function positionFloatingButtons() {
  const frame      = document.querySelector('.mobile-frame');
  const wap        = document.getElementById('floatingWhatsapp');
  const chatAvatar = document.getElementById('floatingChatAvatar');
  if (window.innerWidth >= 430) {
    const rect  = frame.getBoundingClientRect();
    const right = window.innerWidth - rect.right + 14;
    if (wap) { wap.style.position = 'fixed'; wap.style.right = right + 'px'; }
    if (chatAvatar) { chatAvatar.style.position = 'fixed'; chatAvatar.style.right = right + 'px'; }
  } else {
    if (wap) { wap.style.position = 'fixed'; wap.style.right = '14px'; }
    if (chatAvatar) { chatAvatar.style.position = 'fixed'; chatAvatar.style.right = '14px'; }
  }
}
window.addEventListener('resize', positionFloatingButtons);
positionFloatingButtons();

/* ===========================
   IMAGE FALLBACKS
   =========================== */
document.querySelectorAll('img:not(#pixQrImage)').forEach(img => {
  img.addEventListener('error', function () {
    const w = this.offsetWidth  || 72;
    const h = this.offsetHeight || 72;
    const div = document.createElement('div');
    div.style.cssText = `width:${w}px;height:${h}px;background:linear-gradient(135deg,#f3d9c0,#d4956e);border-radius:inherit;display:block;`;
    this.parentNode.insertBefore(div, this);
    this.style.display = 'none';
  });
});

document.addEventListener('keydown', event => {
  const modal = document.querySelector('.modal-overlay.open');
  if (!modal) return;
  if (event.key === 'Escape' && modal.id !== 'checkoutModalOverlay') closeModal(modal.id);
  if (event.key !== 'Tab') return;
  const items = [...modal.querySelectorAll('button:not(:disabled), input, a[href], [tabindex="0"]')]
    .filter(element => element.getClientRects().length);
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
// Buyer identity and recovery: never grants access without server verification.

document.querySelectorAll('[data-buyer-access]').forEach(link=>{link.href='/meu-acesso';});
function openBuyerRecovery(){location.assign('/esqueci-senha');}
if(new URLSearchParams(location.search).get('recover')==='1')openBuyerRecovery();
else {
  // A saved order is resumed only after an explicit choice, never on reload.
  // Consume the VIP contact link so refreshing it cannot reopen checkout.
  const url = new URL(location.href);
  const buy = url.searchParams.get('buy');
  if (buy === 'ayla_whatsapp_unlock') {
    url.searchParams.delete('buy');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    if (performance.getEntriesByType('navigation')[0]?.type !== 'reload') {
      window.ageReady.then(() => openCheckout(buy));
    }
  }
}
window.ageReady.then(refreshPendingPixNotice);
window.addEventListener('storage', event => { if (event.key?.startsWith(AylaCheckouts.prefix)) refreshPendingPixNotice(); });
window.addEventListener('focus', refreshPendingPixNotice);


// Contato pago: usa o checkout existente e uma credencial separada do VIP.
async function openPaidContact(access) {
  const response = await fetch(API_BASE + '/api/contact/' + encodeURIComponent(access.orderId), {
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || !data.whatsapp) throw new Error(data.error || 'Contato indisponível.');
  const url = new URL(data.whatsapp);
  if (url.protocol !== 'https:') throw new Error('Contato inválido.');
  window.location.assign(url.href);
}
const contactChat = document.getElementById('contactChat');
const contactFab = document.getElementById('contactFab');
const contactTyping = document.getElementById('contactTyping');
const contactWelcome = document.getElementById('contactWelcome');
let contactWelcomeTimer;
function closeContactChat() {
  clearTimeout(contactWelcomeTimer);
  contactTyping.hidden = true;
  contactWelcome.hidden = true;
  contactChat.hidden = true;
  contactFab.setAttribute('aria-expanded', 'false');
}
contactFab.addEventListener('click', () => {
  if (!contactChat.hidden) { closeContactChat(); return; }
  contactChat.hidden = false;
  contactFab.setAttribute('aria-expanded', 'true');
  contactWelcome.hidden = true;
  contactTyping.hidden = false;
  clearTimeout(contactWelcomeTimer);
  contactWelcomeTimer = setTimeout(() => {
    if (contactChat.hidden) return;
    contactTyping.hidden = true;
    contactWelcome.hidden = false;
  }, 4000);
  document.getElementById('contactChatClose').focus();
});
document.getElementById('contactChatClose').addEventListener('click', () => { closeContactChat(); contactFab.focus(); });
contactChat.addEventListener('keydown', e => { if (e.key === 'Escape') { closeContactChat(); contactFab.focus(); } });
async function showContactUnlock() {
  closeContactChat(); openModal('contactUnlockModal');
  const button = document.getElementById('contactBuy');
  const status = document.getElementById('contactUnlockStatus');
  button.disabled = true; status.textContent = 'Consultando disponibilidade…';
  try {
    const response = await fetch(API_BASE + '/api/contact', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Contato temporariamente indisponível.');
    const data = await response.json();
    const contactPrice = Number(data.price).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
    const accountResponse = await fetch(API_BASE + '/api/buyer/account');
    const account = accountResponse.ok ? await accountResponse.json() : null;
    const owned = account?.orders?.find(o => o.grant_type === 'contact' && o.status === 'ACTIVE');
    const access = owned ? {orderId: owned.public_id} : null;
    const saved = Boolean(access);
    button.textContent = saved ? 'Abrir meu WhatsApp' : 'DESBLOQUEAR POR ' + contactPrice;
    button.disabled = !data.available;
    status.textContent = data.available ? '' : 'Contato temporariamente indisponível. Nenhuma cobrança será gerada.';
    button.onclick = async () => {
      if (saved) {
        button.disabled = true;
        try { await openPaidContact(access); } catch (error) { status.textContent = error.message; button.disabled = false; }
      } else { closeModal('contactUnlockModal'); openCheckout('ayla_whatsapp_unlock'); }
    };
  } catch (error) { status.textContent = error.message; }
}
document.getElementById('contactReply').addEventListener('submit', e => {
  e.preventDefault();
  e.currentTarget.querySelector('input').value = '';
  showContactUnlock();
});
for (const id of ['contactUnlockClose','contactUnlockLater']) document.getElementById(id).addEventListener('click', () => closeModal('contactUnlockModal'));

window.addEventListener('hashchange', refreshPendingPixNotice);
setInterval(() => { if (!document.hidden) refreshPendingPixNotice(); }, 60000);
