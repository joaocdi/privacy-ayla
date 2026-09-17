/* ==========================================================================
   ÁREA VIP — entrega da assinatura.

   Esta página NÃO decide nada. Ela guarda a credencial do comprador (o mesmo
   token de checkout que já prova a posse do pedido) e pergunta ao servidor o
   que pode mostrar. Sem assinatura ativa, o backend não devolve feed nem link
   de mídia — não existe "localStorage.paid = true" que abra este conteúdo.
   ========================================================================== */

const API_BASE = location.protocol === 'file:'
  || (['localhost', '127.0.0.1'].includes(location.hostname) && ['5500', '5501'].includes(location.port))
  ? 'http://localhost:3333'
  : '';

const STORAGE_KEY = 'ayla.vip.access';

const $ = (id) => document.getElementById(id);
const LIKE_KEY = 'ayla.vip.likes';
let likedPosts;
try { likedPosts = new Set(JSON.parse(localStorage.getItem(LIKE_KEY) || '[]').map(String)); }
catch (_) { likedPosts = new Set(); }
let currentFeed = [];
/**
 * Mídia que não abre (arquivo ainda não enviado, link expirado, erro do
 * Storage) vira um aviso curto no lugar do <img> quebrado. A moldura some:
 * nada de área gigante vazia no meio do feed.
 */
function mediaUnavailable(cell, { draft }) {
  if (cell.dataset.unavailable === '1') return;
  cell.dataset.unavailable = '1';
  cell.querySelectorAll('img, video, .vip-video-play').forEach(node => node.remove());
  cell.classList.add('vip-media-missing');
  const aviso = document.createElement('p');
  aviso.className = 'vip-media-missing-text';
  aviso.textContent = draft ? 'Mídia ainda não enviada.' : 'Mídia indisponível no momento.';
  cell.append(aviso);
}

const vipVideoObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) entry.target.preload = 'metadata';
    else if (!entry.target.paused) entry.target.pause();
  }
}, { rootMargin: '200px 0px', threshold: 0 });
let currentProfile = {};
let returnFocus = null;

/* ------------------------------------------------------------ credencial */

/**
 * A entrada vem da página de venda como /vip#o=<pedido>&t=<token>.
 * Guardamos e limpamos a hash na hora: o token não fica no histórico do
 * navegador nem vaza em Referer.
 */
function readAccess() {
  if(window.accountVipAccess)return window.accountVipAccess;
  const hash = new URLSearchParams(location.hash.slice(1));
  const orderId = hash.get('o');
  const token = hash.get('t');

  if (orderId && /^[a-f0-9]{64}$/.test(token || '')) {
    const access = { orderId, token };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(access)); } catch (_) { /* modo privado */ }
    history.replaceState(null, '', location.pathname);
    return access;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.orderId && /^[a-f0-9]{64}$/.test(saved.token || '')) return saved;
  } catch (_) { /* ignora */ }

  return null;
}

function forgetAccess() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignora */ }
}

/* ---------------------------------------------------------------- telas */

function showBlocked(title, text, buttonLabel = 'VOLTAR PARA A PÁGINA') {
  $('vipLoading').hidden = true;
  $('vipContent').hidden = true;
  $('vipBadge').hidden = true;
  $('vipBlockedTitle').textContent = title;
  $('vipBlockedText').textContent = text;
  $('vipBlockedButton').textContent = buttonLabel;
  $('vipBlockedButton').href = buttonLabel === 'TENTAR DE NOVO' ? location.pathname : '/';
  $('vipBlocked').hidden = false;
}

/* ----------------------------------------------------------------- boot */

/**
 * Revisão da criadora.
 *
 * Pergunta ao servidor se ESTA sessão é administradora. Quem decide é o
 * backend (sessão válida + role admin no banco); o navegador só recebe o feed
 * se a resposta for sim. Nenhum pedido, cobrança ou assinatura é envolvido —
 * é um caminho separado do caminho do comprador.
 */
async function adminPreview() {
  try {
    const response = await fetch(`${API_BASE}/api/vip/preview`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data && data.granted ? data : null;
  } catch (_) { return null; }
}

(async function start() {
  let access = readAccess();
  try { const r=await fetch('/api/buyer/account');const account=await r.json();if(account.enabled){
    const order=account.orders?.find(o=>o.grant_type==='subscription'&&o.status==='ACTIVE'&&(!o.expires_at||Date.parse(o.expires_at.replace(' ','T')+'Z')>Date.now()));
    // Existing pre-account purchases retain their server-validated credential.
    access=order?{orderId:order.public_id,token:''}:access;
    if(access)window.accountVipAccess=access;
  }}catch(_){}

  if (!access) {
    const preview = await adminPreview();
    if (preview) return render(preview);
    return showBlocked(
      'Acesso negado.',
      'Esta área é liberada assim que o seu pagamento é confirmado. Faça a assinatura na página principal.',
      'IR PARA A ASSINATURA'
    );
  }

  let response;
  let data;
  try {
    response = await fetch(`${API_BASE}/api/vip/${encodeURIComponent(access.orderId)}`, {
      headers: { Authorization: 'Bearer ' + access.token },
      signal: AbortSignal.timeout(15000)
    });
    data = await response.json().catch(() => ({}));
  } catch (_) {
    return showBlocked('Não consegui carregar', 'Falha de conexão com o servidor. Tente novamente em instantes.', 'TENTAR DE NOVO');
  }

  if (response.status === 403 && data.expired) {
    forgetAccess();
    // Credencial velha guardada no navegador não pode trancar a criadora fora.
    const preview = await adminPreview();
    if (preview) return render(preview);
    return showBlocked('Seu acesso expirou.', 'Renove para continuar vendo o conteúdo.', 'RENOVAR ACESSO');
  }

  if (response.status >= 500 || response.status === 429) {
    return showBlocked('Só um instante…', 'Não conseguimos carregar seu conteúdo agora. Tente novamente.', 'TENTAR DE NOVO');
  }

  if (!response.ok || !data.granted) {
    forgetAccess();
    const preview = await adminPreview();
    if (preview) return render(preview);
    return showBlocked(
      'Acesso negado.',
      'Não encontrei uma assinatura ativa para este acesso.',
      'IR PARA A ASSINATURA'
    );
  }

  render(data);
})();

/* --------------------------------------------------------------- render */

function render(data) {
  const profile = data.profile || {};

  $('vipCover').src = profile.cover || '';
  AylaFrame.apply($('vipCover'),profile.coverCrop,{role:'cover',box:document.querySelector('.vip-cover')});
  $('vipAvatar').src = profile.avatar || '';
  AylaFrame.apply($('vipAvatar'),profile.avatarCrop,{role:'avatar'});
  $('vipName').textContent = profile.name || '';
  $('vipUsername').textContent = profile.username || '';
  $('vipBio').textContent = profile.bio || '';
  if (!profile.verified) $('vipVerified').remove();

  // Os mesmos números da página de venda, do mesmo objeto de perfil.
  const stats = profile.stats;
  if (stats) {
    $('vipStatPhotos').textContent = stats.photos ?? '';
    $('vipStatVideos').textContent = stats.videos ?? '';
    $('vipStatLikes').textContent = stats.likes ?? '';
    $('vipStats').hidden = false;
  }

  if (data.expiresAt) {
    const timestamp = String(data.expiresAt).replace(' ', 'T');
    const until = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp) ? timestamp : timestamp + 'Z');
    if (!Number.isNaN(until.getTime())) {
      $('vipExpiry').textContent = 'Acesso válido até '
        + until.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    }
  }

  currentFeed = data.feed || [];
  currentProfile = profile;
  const count = currentFeed.filter(post => post.type !== 'cta').length;
  // As abas repetem os números do perfil, exatamente como na página inicial.
  $('vipTabPostsLabel').textContent = (stats?.posts ?? count) + ' Postagens';
  $('vipTabMediaLabel').textContent = stats
    ? (Number(stats.photos || 0) + Number(stats.videos || 0)) + ' Mídias'
    : count + ' Mídias';
  renderFeed('all');

  $('vipLoading').hidden = true;
  $('vipBlocked').hidden = true;
  // Revisão da criadora não é assinatura: o selo diz o que realmente é.
  $('vipBadge').textContent = data.admin ? 'Modo revisão' : 'Assinatura ativa';
  $('vipBadge').hidden = false;
  if (data.admin) document.body.classList.add('vip-review');
  $('vipContent').hidden = false;
}

function renderFeed(filter) {
  vipVideoObserver.disconnect();
  const feed = currentFeed.filter(post => post.type !== 'cta' && (filter === 'all' || post.type === filter));
  $('vipFeed').replaceChildren(...feed.map(post => buildPost(post, currentProfile)));
  $('vipEmpty').hidden = feed.length > 0;
}

function buildPost(post, profile) {
  return post.type === 'cta' ? buildPromo(post) : buildMediaPost(post, profile);
}

/** Bloco de chamada. Hoje só informa — a venda do contato segue desativada. */
function buildPromo(post) {
  const section = document.createElement('section');
  section.className = 'vip-promo';

  const label = document.createElement('span');
  label.className = 'vip-eyebrow'; label.textContent = 'NOVIDADES DO CLUBE';

  const title = document.createElement('h2');
  title.textContent = post.title || '';

  const text = document.createElement('p');
  text.textContent = post.text || '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'vip-cta';
  button.textContent = post.button || 'SABER MAIS';
  button.addEventListener('click', () => openVipModal('contact'));

  section.append(label, title, text, button);
  return section;
}

function buildMediaPost(post, profile) {
  const article = document.createElement('article');
  article.className = 'vip-post';
  article.dataset.postId = post.id;

  // cabeçalho
  const head = document.createElement('div');
  head.className = 'vip-post-head';

  const avatar = document.createElement('img');
  avatar.src = profile.avatar || '';
  avatar.alt = '';

  const info = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = profile.name || '';
  if (profile.verified) name.append(verifiedBadge());
  const username = document.createElement('small');
  username.textContent = profile.username || '';
  info.append(name, username);

  // Sem etiqueta de FOTO/VÍDEO: a própria mídia já diz o que é.
  head.append(avatar, info);
  AylaFrame.apply(avatar,profile.avatarCrop,{role:"avatar"});
  // Só na revisão da criadora: diz que este post ainda não está publicado.
  if (post.draft) {
    const draft = document.createElement('span');
    draft.className = 'vip-draft-tag';
    draft.textContent = 'Rascunho';
    head.append(draft);
  }
  article.append(head);

  // mídia (o src é um link assinado, válido por poucos minutos)
  // TODA publicação usa a mesma moldura 4:5 e a mídia PREENCHE essa moldura
  // (cover, no CSS). Não sobra área nenhuma para preencher: nenhum post fica
  // com tarja preta, nenhum fica com faixa borrada de um lado enquanto o
  // vizinho fica do outro, e todos têm exatamente o mesmo tamanho.
  const box = document.createElement('div');
  box.className = 'vip-media';

  // Carrossel: uma mídia continua sendo uma mídia, e o cartão fica idêntico.
  // Com duas ou mais, o mesmo cartão ganha swipe, setas e o indicador.
  const items = Array.isArray(post.items) && post.items.length
    ? post.items
    : [{ id: post.id, type: post.type, crop: post.crop, media: post.media }];
  if (items.some(item => item.type === 'video')) box.classList.add('is-video');

  AylaCarousel.build(box, items.map((item, index) => (cell) => {
    if (item.type === 'video') {
      const video = document.createElement('video');
      video.addEventListener('error', () => mediaUnavailable(cell, { draft: post.draft }));
      video.src = API_BASE + item.media;
      video.controls = true;
      video.playsInline = true;
      // Só o primeiro pede metadados; os outros só quando chegam perto.
      video.preload = 'none';
      vipVideoObserver.observe(video);
      video.setAttribute('playsinline', '');
      video.setAttribute('controlsList', 'nodownload');
      cell.append(video);
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'vip-video-play';
      playButton.textContent = '▶';
      playButton.setAttribute('aria-label', 'Reproduzir vídeo');
      playButton.addEventListener('click', event => {
        event.stopPropagation();
        video.play().catch(() => { playButton.hidden = false; });
      });
      video.addEventListener('play', () => { playButton.hidden = true; });
      video.addEventListener('pause', () => { playButton.hidden = false; });
      video.addEventListener('ended', () => { playButton.hidden = false; });
      cell.append(playButton);
      AylaFrame.apply(video, item.crop, { box: cell });
    } else {
      const image = document.createElement('img');
      image.decoding = 'async';
      image.addEventListener('error', () => mediaUnavailable(cell, { draft: post.draft }));
      image.src = API_BASE + item.media;
      image.alt = post.caption || 'Foto exclusiva da Ayla';
      image.loading = index === 0 ? 'eager' : 'lazy';
      cell.append(image);
      AylaFrame.apply(image, item.crop, { box: cell });
    }
  }), {
    // O vídeo que entra em cena volta a poder tocar; o que sai já foi pausado.
    onEnter: video => {
      const bounds = video.getBoundingClientRect();
      if (bounds.bottom >= -200 && bounds.top <= innerHeight + 200) video.preload = 'metadata';
    }
  });

  article.append(box);
  if (post.caption) {
    const caption = document.createElement('p');
    caption.className = 'vip-caption';
    const author = document.createElement('strong'); author.textContent = profile.name + ' ';
    caption.append(author, document.createTextNode(post.caption)); article.append(caption);
  }
  article.append(buildActions(post));
  return article;
}

/** Posts gerenciados usam reações reais. O fallback antigo mantém a reação local. */
function buildActions(post) {
  const bar = document.createElement('div');
  bar.className = 'vip-actions';
  const id = String(post.id);
  const base = Number.isFinite(post.likes) && post.likes >= 0 ? post.likes : 0;
  let realCount = base;
  let realLiked = Boolean(post.liked);
  const like = document.createElement('button');
  like.type = 'button'; like.className = 'vip-action vip-like';
  like.title = post.realLikes ? 'Curtidas registradas para esta assinatura.' : 'Contagem do feed antigo. Sua reação fica neste navegador.';
  like.append(icon('M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z'));
  const count = document.createElement('span'); like.append(count);
  function update() {
    const liked = post.realLikes ? realLiked : likedPosts.has(id);
    like.classList.toggle('is-liked', liked); like.setAttribute('aria-pressed', String(liked));
    like.setAttribute('aria-label', (liked ? 'Descurtir' : 'Curtir') + ' publicação');
    const value = post.realLikes ? realCount : base + Number(liked);
    count.textContent = value.toLocaleString('pt-BR');
  }
  like.addEventListener('click', async () => {
    if (post.realLikes) {
      const access = readAccess();
      if (!access) {
        // Modo revisão da criadora: não existe assinatura para registrar a curtida.
        like.classList.remove('is-tapped'); void like.offsetWidth; like.classList.add('is-tapped');
        notice('Modo revisão: as curtidas só contam quando um assinante toca no coração.');
        return;
      }
      if (like.disabled) return;
      like.disabled = true;
      const previous = { count: realCount, liked: realLiked };
      realLiked = !realLiked; realCount += realLiked ? 1 : -1; update();
      try {
        const response = await fetch(`${API_BASE}/api/vip/${encodeURIComponent(access.orderId)}/posts/${encodeURIComponent(id)}/like`, {
          method: 'PUT', headers: { Authorization: 'Bearer ' + access.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ liked: realLiked }), signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error('Não foi possível registrar a curtida.');
        const data = await response.json();
        realCount = data.likes; realLiked = data.liked; post.likes = realCount; post.liked = realLiked;
        like.title = 'Curtida atualizada.'; update();
      } catch (_) { realCount = previous.count; realLiked = previous.liked; update(); like.title = 'Não foi possível registrar. Tente novamente.'; }
      finally { like.disabled = false; }
      return;
    }
    if (likedPosts.has(id)) likedPosts.delete(id); else likedPosts.add(id);
    try { localStorage.setItem(LIKE_KEY, JSON.stringify([...likedPosts])); } catch (_) {}
    update();
  });
  update();
  const comment = document.createElement('button');
  comment.type = 'button'; comment.className = 'vip-action vip-comment';
  comment.disabled = true;
  comment.title = 'Comentários indisponíveis';
  comment.setAttribute('aria-label', 'Comentários indisponíveis');
  comment.append(icon('M21 11.5a9 9 0 0 1-9 9 10 10 0 0 1-4-.9L3 21l1.4-4.8A9 9 0 1 1 21 11.5z'));
  bar.append(like, comment);
  return bar;
}

/** Aviso curto no rodapé da tela (some sozinho). */
function notice(text) {
  let box = document.getElementById('vipNotice');
  if (!box) {
    box = document.createElement('div');
    box.id = 'vipNotice'; box.className = 'vip-notice'; box.setAttribute('role', 'status');
    document.body.append(box);
  }
  box.textContent = text;
  box.classList.add('is-visible');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => box.classList.remove('is-visible'), 2600);
}

function action(pathData, label) {
  const span = document.createElement('span');
  span.className = 'vip-action';
  span.append(icon(pathData));
  if (label) span.append(document.createTextNode(label));
  return span;
}

function icon(pathData) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '19');
  svg.setAttribute('height', '19');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  for (const data of [].concat(pathData)) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', data);
    svg.append(shape);
  }
  return svg;
}

function verifiedBadge() {
  const image = document.createElement('img');
  image.src = '/verified-ayla.png';
  image.width = 14;
  image.height = 14;
  image.className = 'verified-icon';
  image.alt = 'Verificado';
  return image;
}

/* --------------------------------------------------------------- modal */

$('vipChat')?.addEventListener('click', async () => {
  const button=$('vipChat');button.disabled=true;
  try {
    const response=await fetch('/api/buyer/account');const account=await response.json();
    const owned=account.orders?.find(o=>o.grant_type==='contact'&&o.status==='ACTIVE');
    if(!owned)return location.assign('/?buy=ayla_whatsapp_unlock');
    const result=await fetch('/api/contact/'+encodeURIComponent(owned.public_id));const contact=await result.json();
    if(!result.ok||!contact.whatsapp)throw Error('Não foi possível abrir seu WhatsApp.');
    location.assign(contact.whatsapp);
  }catch(_){location.assign('/meu-acesso');}finally{button.disabled=false;}
});

// Duas abas: a lista de publicações e a grade de mídias. Sem filtro de
// foto/vídeo — o feed mostra tudo junto, como na página inicial.
for (const [button, grid] of [[$('vipTabPosts'), false], [$('vipTabMedia'), true]]) {
  button?.addEventListener('click', () => {
    for (const item of document.querySelectorAll('.vip-tab')) {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-selected', String(item === button));
    }
    $('vipFeed').classList.toggle('is-grid', grid);
  });
}
