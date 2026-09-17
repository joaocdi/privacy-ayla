const $ = id => document.getElementById(id);
let csrf = '';
let rows = [];
let editing = null;
let uploading = false;
let upload = null;
let previewUrl = null;
let maximum = 0;
let derived = null;
/**
 * Amostra da HOME.
 *
 * Reduzida aqui, no navegador do painel, para 64x80: nesse tamanho o
 * conteúdo do arquivo já se perdeu de forma irreversível. O servidor
 * reconfere formato e dimensão antes de guardar, e a mídia original
 * continua só no bucket privado.
 */
const PREVIEW_WIDTH = 64;
const PREVIEW_HEIGHT = 80;
function once(element, event) {
  return new Promise((resolve, reject) => {
    element.addEventListener(event, resolve, { once: true });
    element.addEventListener('error', () => reject(new Error('Não foi possível ler esta mídia.')), { once: true });
  });
}
async function derive(file) {
  const url = URL.createObjectURL(file);
  try {
    let source, width, height;
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
      await once(video, 'loadeddata');
      try {
        video.currentTime = Math.min(1, Math.max(0, (video.duration || 2) / 4));
        await once(video, 'seeked');
      } catch (_) { /* primeiro quadro já serve */ }
      source = video; width = video.videoWidth; height = video.videoHeight;
    } else {
      const image = document.createElement('img');
      image.src = url;
      await once(image, 'load');
      source = image; width = image.naturalWidth; height = image.naturalHeight;
    }
    if (!width || !height) throw new Error('Mídia sem dimensões legíveis.');
    return AylaImageTools.preview(source, width, height);
  } finally { URL.revokeObjectURL(url); }
}
async function api(route, method = 'GET', body, headers = {}) {
  const options = { method, headers: { 'x-csrf-token': csrf, ...headers } };
  if (body !== undefined) {
    options.body = body instanceof Blob ? body : JSON.stringify(body);
    if (!(body instanceof Blob)) options.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch('/api/admin' + route, options);
  if (response.status === 401) { location.assign('/admin/login'); throw new Error('Sessão encerrada.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir.');
  return data;
}
function say(text) { $('message').textContent = text; }
function button(label, action) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await action(); } catch (error) { say(error.message); }
    finally { b.disabled = false; }
  });
  return b;
}
async function load() {
  const data = await api('/posts'); rows = data.posts;
  $('feedSource').textContent = data.source === 'managed' ? 'Ativo: publicações deste painel.' : 'Ativo: feed antigo. Prepare seus posts aqui antes de trocar.';
  $('activate').disabled = data.source === 'managed'; $('fallback').disabled = data.source === 'legacy';
  render();
}
function payload(post) {
  return { caption: post.caption, sort_order: post.sort_order, published: Boolean(post.published),
    show_as_preview: Boolean(post.show_as_preview), version: post.version };
}
function render() {
  const filter = $('filter').value;
  const visible = rows.filter(p => filter === 'archived' ? p.archived : !p.archived && (filter === 'active' || (filter === 'published' ? p.published : !p.published)));
  $('empty').hidden = visible.length > 0;
  $('posts').replaceChildren(...visible.map(p => {
    const card = document.createElement('article'); card.className = 'post';
    const top = document.createElement('div'); top.className = 'post-top';
    const title = document.createElement('strong'); title.textContent = `${p.type === 'image' ? 'Foto' : 'Vídeo'} · Ordem ${p.sort_order}`;
    const badge = document.createElement('span'); badge.className = 'pill'; badge.textContent = p.archived ? 'Arquivado' : p.published ? 'Publicado' : 'Rascunho';
    top.append(title, badge);
    if (p.show_as_preview) { const home = document.createElement('span'); home.className = 'pill home'; home.textContent = 'Prévia HOME'; top.append(home); }
    const caption = document.createElement('p'); caption.className = 'post-caption'; caption.textContent = p.caption || 'Sem legenda';
    const meta = document.createElement('p'); meta.className = 'post-meta';
    meta.textContent = `Prévia na HOME: ${p.show_as_preview ? 'sim' : 'não'} · Atualizado: ${p.updated_at} UTC`;
    const actions = document.createElement('div'); actions.className = 'actions';
    if (p.archived) actions.append(button('Restaurar como rascunho', async () => { await api(`/posts/${p.id}/restore`, 'POST', { version: p.version }); await load(); }));
    else {
      actions.append(button('Editar', () => openEditor(p)), button(p.published ? 'Despublicar' : 'Publicar', async () => {
        await api('/posts/' + p.id, 'PUT', { ...payload(p), published: !p.published }); await load(); say(p.published ? 'Post despublicado.' : 'Post publicado.');
      }), button(p.show_as_preview ? 'Tirar da prévia da HOME' : 'Mostrar na prévia da HOME', async () => {
        if (!p.show_as_preview && !p.has_preview) throw new Error('Este post ainda não tem amostra. Abra Editar e selecione a mídia novamente.');
        await api('/posts/' + p.id, 'PUT', { ...payload(p), show_as_preview: !p.show_as_preview }); await load();
        say(p.show_as_preview ? 'Post fora da prévia da HOME.' : 'Post marcado como prévia da HOME.');
      }), button('Mover para cima', async () => {
        await move(p, -1); await load(); say('Ordem atualizada.');
      }), button('Mover para baixo', async () => {
        await move(p, 1); await load(); say('Ordem atualizada.');
      }), button('Excluir / arquivar', async () => {
        if (!confirm('Arquivar esta publicação? Ela sairá do feed. A mídia será preservada e você poderá restaurar o post.')) return;
        await api('/posts/' + p.id, 'DELETE', { version: p.version }); await load(); say('Publicação arquivada.');
      }));
    }
    const preview = document.createElement('a'); preview.href = `/api/admin/posts/${p.id}/media`; preview.target = '_blank'; preview.rel = 'noopener noreferrer'; preview.textContent = 'Ver mídia privada';
    card.append(top, caption, meta, preview, actions); return card;
  }));
}
/**
 * Mover para cima/baixo troca a ordem com o vizinho da lista ativa.
 * Empate em sort_order é resolvido abrindo espaço de um ponto, para a
 * ordenação (sort_order, created_at, id) não depender do desempate.
 */
async function move(post, direction) {
  const ordered = rows.filter(p => !p.archived);
  const index = ordered.findIndex(p => p.id === post.id);
  const neighbour = ordered[index + direction];
  if (!neighbour) return;
  if (neighbour.sort_order === post.sort_order) {
    await api('/posts/' + post.id, 'PUT', { ...payload(post), sort_order: post.sort_order + direction });
    return;
  }
  await api('/posts/' + post.id, 'PUT', { ...payload(post), sort_order: neighbour.sort_order });
  await api('/posts/' + neighbour.id, 'PUT', { ...payload(neighbour), sort_order: post.sort_order });
}
function openEditor(post = null) {
  editing = post; upload = null; derived = null;
  $('postForm').reset(); $('preview').replaceChildren();
  $('previewSample').hidden = true; $('previewSampleImg').removeAttribute('src');
  if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
  $('editorTitle').textContent = post ? 'Editar publicação' : 'Nova publicação';
  $('caption').value = post?.caption || '';
  $('sortOrder').value = post?.sort_order ?? (rows.length ? Math.max(...rows.map(p => p.sort_order)) + 10 : 0);
  $('published').checked = Boolean(post?.published);
  $('showAsPreview').checked = Boolean(post?.show_as_preview);
  $('file').required = !post;
  $('editorMessage').textContent = post ? 'Para trocar a mídia, selecione outro arquivo. Sem seleção, a mídia atual será mantida.' : '';
  $('progress').hidden = true; $('editor').showModal();
}
$('file').addEventListener('change', async () => {
  upload = null; derived = null; $('preview').replaceChildren();
  $('previewSample').hidden = true; $('previewSampleImg').removeAttribute('src');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const file = $('file').files[0]; if (!file) return;
  previewUrl = URL.createObjectURL(file);
  const element = document.createElement(file.type.startsWith('video/') ? 'video' : 'img');
  element.src = previewUrl; if (element.tagName === 'VIDEO') element.controls = true; else element.alt = 'Prévia da mídia selecionada';
  $('preview').append(element);
  try {
    derived = await derive(file);
    $('previewSampleImg').src = derived; $('previewSample').hidden = false;
  } catch (error) {
    derived = null;
    $('editorMessage').textContent = 'Não consegui gerar a amostra da HOME desta mídia. Você ainda pode publicar no VIP.';
  }
});
async function sendFile(file, state = { upload }, progressId = 'progress', messageId = 'editorMessage') {
  file = await AylaImageTools.post(file);
  let upload = state.upload;
  if (file.size > maximum) throw new Error(`Arquivo acima do limite de ${Math.round(maximum / 1024 / 1024)} MB.`);
  if (!upload) upload = await api('/uploads', 'POST', { size: file.size, mime: file.type });
  else upload = { ...upload, ...await api('/uploads/' + upload.id) };
  state.upload = upload;
  $(progressId).hidden = false;
  while (!upload.complete) {
    $(messageId).textContent = `Enviando mídia: ${Math.round(upload.offset / file.size * 100)}%. Mantenha esta janela aberta.`;
    const part = file.slice(upload.offset, Math.min(file.size, upload.offset + upload.chunkSize));
    const result = await api('/uploads/' + upload.id, 'PATCH', part, { 'Content-Type': 'application/octet-stream', 'upload-offset': String(upload.offset) });
    upload = { ...upload, ...result };
    $(progressId).value = Math.round(upload.offset / file.size * 100);
    state.upload = upload;
  }
  state.upload = upload;
  return upload.id;
}
$('postForm').addEventListener('submit', async event => {
  event.preventDefault(); if (uploading) return;
  const file = $('file').files[0];
  const body = { caption: $('caption').value, sort_order: Number($('sortOrder').value), published: $('published').checked,
    show_as_preview: $('showAsPreview').checked, version: editing?.version };
  if (derived) body.preview_image = derived;
  const controls = [$('file'), $('caption'), $('sortOrder'), $('published'), $('showAsPreview')];
  uploading = true; $('save').disabled = true; $('closeEditor').disabled = true;
  for (const control of controls) control.disabled = true;
  try {
    if (file) { const state = { upload }; try { body.uploadId = await sendFile(file, state); } finally { upload = state.upload; } }
    await api(editing ? '/posts/' + editing.id : '/posts', editing ? 'PUT' : 'POST', body);
    $('editor').close(); await load(); say('Publicação salva.');
  } catch (error) { $('editorMessage').textContent = error.message + ' Você pode tentar salvar novamente.'; }
  finally {
    uploading = false; $('save').disabled = false; $('closeEditor').disabled = false;
    for (const control of controls) control.disabled = false;
  }
});
$('editor').addEventListener('cancel', event => { if (uploading) event.preventDefault(); });
$('closeEditor').addEventListener('click', () => { if (!uploading) $('editor').close(); });
$('newPost').addEventListener('click', () => { if (!uploading) openEditor(); });
$('filter').addEventListener('change', render);
async function action(fn) { try { await fn(); } catch (error) { say(error.message); } }
$('refresh').addEventListener('click', () => action(load));
$('logout').addEventListener('click', () => action(async () => { await api('/logout', 'POST', {}); location.assign('/admin/login'); }));
$('activate').addEventListener('click', () => action(async () => {
  if (!confirm('Trocar para o feed do painel? Somente posts publicados serão mostrados. Se nenhum estiver publicado, o feed ficará vazio.')) return;
  await api('/feed-source', 'POST', { source: 'managed' }); await load(); say('Feed do painel ativado.');
}));
$('fallback').addEventListener('click', () => action(async () => {
  if (!confirm('Voltar a mostrar os posts do arquivo antigo para os assinantes?')) return;
  await api('/feed-source', 'POST', { source: 'legacy' }); await load();
}));
$('migrate').addEventListener('click', () => action(async () => {
  if (!confirm('Importar os registros antigos como rascunhos? Nenhuma mídia será enviada e o feed ativo não mudará.')) return;
  const result = await api('/migrate', 'POST', {}); await load(); say(`${result.imported} registros importados como rascunhos.`);
}));
action(async () => {
  const session = await api('/session'); csrf = session.csrf; maximum = session.uploadMaxBytes;
  $('uploadHint').textContent = `JPG, PNG, WebP, MP4 ou WebM · até ${Math.round(maximum / 1024 / 1024)} MB. ${session.storage === 'supabase' ? 'Envio para o bucket privado.' : 'Configure o Storage Supabase para habilitar o envio.'}`;
  await load();
  await loadProfile();
});

let profileVersion = 0;
const profileUploads = { avatar: {}, cover: {} };
async function loadProfile() {
  const profile = await api('/profile'); profileVersion = profile.version;
  $('profileForm').reset();
  for (const field of ['Name','Username','Bio']) $('profile' + field).value = profile[field.toLowerCase()];
  $('profileAvatar').src = profile.avatar; $('profileCover').src = profile.cover;
  profileUploads.avatar = {}; profileUploads.cover = {};
}
for (const role of ['Avatar','Cover']) $('profile' + role + 'File').addEventListener('change', () => { profileUploads[role.toLowerCase()] = {}; });
$('reloadProfile').addEventListener('click', () => action(loadProfile));
$('profileForm').addEventListener('submit', async event => {
  event.preventDefault(); if (uploading) return;
  const body = { name: $('profileName').value, username: $('profileUsername').value, bio: $('profileBio').value, version: profileVersion };
  const controls = [...$('profileForm').elements];
  uploading = true; controls.forEach(el => el.disabled = true);
  try {
    for (const role of ['Avatar','Cover']) {
      const file = $('profile' + role + 'File').files[0];
      if (file) body[role.toLowerCase() + 'UploadId'] = await sendFile(await AylaImageTools.profile(file, role.toLowerCase()), profileUploads[role.toLowerCase()], 'profileProgress', 'profileMessage');
    }
    await api('/profile', 'PUT', body); await loadProfile();
    $('profileMessage').textContent = 'Perfil salvo. HOME e VIP usarão estes dados ao abrir ou atualizar a página.';
  } catch (error) { $('profileMessage').textContent = error.message; }
  finally { uploading = false; controls.forEach(el => el.disabled = false); $('profileProgress').hidden = true; }
});

(async()=>{const target=document.getElementById('conversionReport');try{const r=await fetch('/api/admin/conversions');if(!r.ok)throw Error();const data=await r.json();target.textContent='';const note=document.createElement('p');note.textContent=['mock','staging'].includes(data.mode)?'Modo simulado: não representa vendas reais.':'Pagamentos reais';target.append(note);for(const item of data.products){const p=document.createElement('p');p.textContent=item.id+': '+item.opened+' aberturas · '+item.generated+' PIX gerados · '+item.paid+' pagos · '+item.linked+' acessos vinculados · '+item.awaitingClaim+' aguardando cadastro · '+item.whatsappClicks+' cliques WhatsApp';target.append(p);}if(data.reviewOrders?.length){const title=document.createElement('h3');title.textContent='Pedidos que precisam de verificação';target.append(title);for(const order of data.reviewOrders){const row=document.createElement('p');row.style.overflowWrap='anywhere';row.textContent=order.public_id+' · '+order.product_id+' · '+Number(order.amount).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})+' · '+order.created_at;target.append(row);}}}catch(_){target.textContent='Métricas indisponíveis. Atualize para tentar novamente.';}})();

async function loadFunnel(){const out=document.getElementById('funnelReport');if(!out)return;try{const days=document.getElementById('funnelPeriod').value,r=await fetch('/api/admin/funnel?days='+days);if(!r.ok)throw Error();const d=await r.json(),pct=v=>(v*100).toFixed(1)+'%';out.replaceChildren();const rows=[['Visitas',d.visits],['Passaram +18',d.ageConfirmed],['Clicaram em assinar',d.ctaClicks],['Selecionaram plano',d.planSelected],['PIX gerados',d.pixGenerated],['PIX pagos',d.pixPaid],['PIX expirados',d.pixExpired],['Visita → CTA',pct(d.rates.visitToCta)],['CTA → PIX',pct(d.rates.ctaToPix)],['PIX → PAID',pct(d.rates.pixToPaid)]];for(const [label,value] of rows){const line=document.createElement('p');line.textContent=label+': '+value;out.append(line);}const title=document.createElement('h3');title.textContent='Por produto';out.append(title);for(const p of d.products){const line=document.createElement('p');line.textContent=p.name+': '+p.generated+' PIX · '+p.paid+' pagos';out.append(line);}}catch(_){out.textContent='Funil indisponível. Atualize para tentar novamente.';}}
document.getElementById('funnelPeriod')?.addEventListener('change',loadFunnel);loadFunnel();
