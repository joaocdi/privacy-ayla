/* ==========================================================================
   MODO ADMINISTRADOR — dentro do próprio site.

   Carregado pela HOME e pelo /vip. Em toda visita pergunta ao backend
   "sou admin?". Para visitante e para assinante comum a resposta é `false` e
   este arquivo não desenha absolutamente nada — a página fica igual.

   Nada aqui é segurança. Esconder botão não protege ninguém: TODA ação passa
   pelos endpoints administrativos que já existiam, que exigem sessão válida e
   token anti-CSRF no servidor. Este módulo é só a interface.

   Reaproveita o backend existente sem criar nada novo:
     GET/PUT  /api/admin/profile     perfil (creator_profiles)
     GET/POST /api/admin/posts       lista e criação
     PUT      /api/admin/posts/:id   edição, ordem, publicar, prévia HOME
     DELETE   /api/admin/posts/:id   arquivar
     POST     /api/admin/uploads     envio em blocos para o bucket privado
   ========================================================================== */

(function adminMode() {
  const BASE = location.protocol === 'file:'
    || (['localhost', '127.0.0.1'].includes(location.hostname) && ['5500', '5501'].includes(location.port))
    ? 'http://localhost:3333' : '';

  let csrf = '';
  let posts = [];
  let uploadMax = 0;
  let storage = '';
  const $ = id => document.getElementById(id);

  /* ------------------------------------------------------------ requisições */

  async function api(route, method = 'GET', body, headers = {}) {
    const options = { method, headers: { ...headers } };
    if (method !== 'GET') options.headers['x-csrf-token'] = csrf;
    if (body !== undefined) {
      options.body = body instanceof Blob ? body : JSON.stringify(body);
      if (!(body instanceof Blob)) options.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(BASE + '/api/admin' + route, options);
    if (response.status === 401) {
      location.assign('/criadora/login?r=' + encodeURIComponent(location.pathname));
      throw new Error('Sessão encerrada.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir.');
    return data;
  }

  /* ------------------------------------------------------- peças de interface */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, onClick, className = 'am-btn') {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await onClick(); } catch (error) { toast(error.message); }
      finally { node.disabled = false; }
    });
    return node;
  }

  let toastTimer = null;
  function toast(text) {
    let box = $('amToast');
    if (!box) { box = el('div', 'am-toast'); box.id = 'amToast'; document.body.append(box); }
    box.textContent = text;
    box.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('is-on'), 3600);
  }

  /* ----------------------------------------------------------------- modal */

  function openSheet(title, build, onSubmit) {
    // Clique duplo não abre duas fichas nem cria dois posts.
    if (document.querySelector('.am-sheet-overlay')) return null;
    const overlay = el('div', 'am-sheet-overlay');
    const sheet = el('form', 'am-sheet');
    sheet.noValidate = true;
    const head = el('div', 'am-sheet-head');
    head.append(el('h2', null, title));
    const close = button('Fechar', () => overlay.remove(), 'am-btn am-btn-quiet');
    head.append(close);
    const body = el('div', 'am-sheet-body');
    const status = el('p', 'am-sheet-status');
    // Barra de progresso do envio: some quando não há etapa em andamento.
    const progress = el('div', 'am-progress');
    const progressBar = el('i', 'am-progress-bar');
    progress.append(progressBar);
    progress.hidden = true;
    const save = el('button', 'am-btn am-btn-primary', 'Salvar');
    save.type = 'submit';
    const foot = el('div', 'am-sheet-foot');
    const actions = el('div', 'am-sheet-actions');
    actions.append(save);
    foot.append(status, progress, actions);
    sheet.append(head, body, foot);
    overlay.append(sheet);
    document.body.append(overlay);
    document.body.style.overflow = 'hidden';
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
    new MutationObserver((list, observer) => {
      if (!document.body.contains(overlay)) { document.body.style.overflow = ''; observer.disconnect(); }
    }).observe(document.body, { childList: true });

    const context = {
      body, status, save, foot, actions, sheet,
      close: () => overlay.remove(),
      // `say` aceita a etapa e, quando existe, o percentual do envio.
      say: (t, percent) => {
        status.textContent = t;
        const value = Number(percent);
        progress.hidden = !Number.isFinite(value);
        if (Number.isFinite(value)) progressBar.style.width = Math.max(0, Math.min(100, value)) + '%';
      }
    };
    build(context);
    let enviando = false;
    sheet.addEventListener('submit', async event => {
      event.preventDefault();
      // Trava de reentrada: nem clique duplo, nem Enter repetido.
      if (enviando) return;
      enviando = true;
      const extras = [...actions.querySelectorAll('button')];
      save.disabled = true; close.disabled = true;
      extras.forEach(node => { node.disabled = true; });
      try { await onSubmit(context); }
      catch (error) {
        context.say(error.message);
        enviando = false;
        save.disabled = false; close.disabled = false;
        extras.forEach(node => { node.disabled = false; });
      }
    });
    return context;
  }

  /**
   * Bloco do editor: Conteúdo, Visibilidade, Números, Ações.
   *
   * Só agrupa o que já existia — nenhum campo novo, nenhuma etapa a mais.
   */
  function section(parent, title, hint) {
    const box = el('section', 'am-section');
    const head = el('h3', 'am-section-title', title);
    box.append(head);
    if (hint) box.append(el('p', 'am-section-hint', hint));
    parent.append(box);
    return box;
  }

  /**
   * Estado da publicação em uma palavra, do jeito que a criadora pensa:
   * RASCUNHO/PUBLICADO, e onde ele aparece (HOME ou só VIP).
   */
  function statusOf(post) {
    if (!post) return [{ text: 'NOVO', kind: 'novo' }];
    const chips = [];
    if (post.archived) chips.push({ text: 'ARQUIVADO', kind: 'arquivado' });
    chips.push(post.published ? { text: 'PUBLICADO', kind: 'publicado' } : { text: 'RASCUNHO', kind: 'rascunho' });
    if (post.published && !post.archived) {
      chips.push(post.show_as_preview ? { text: 'PÚBLICO', kind: 'publico' } : { text: 'SÓ VIP', kind: 'vip' });
    }
    // Marcado para a HOME sem amostra gerada: precisa de ação da criadora.
    if (post.show_as_preview && !post.has_preview) chips.push({ text: 'PRÉVIA PENDENTE', kind: 'erro' });
    return chips;
  }

  function statusChips(post, className = 'am-chips') {
    const wrap = el('div', className);
    for (const chip of statusOf(post)) wrap.append(el('span', 'am-chip am-chip-' + chip.kind, chip.text));
    return wrap;
  }

  function field(parent, label, control, hint) {
    const wrap = el('label', 'am-field');
    wrap.append(el('span', null, label), control);
    if (hint) wrap.append(el('small', null, hint));
    parent.append(wrap);
    return control;
  }

  function input(type, value = '') {
    const node = document.createElement('input');
    node.type = type; node.value = value;
    return node;
  }

  function checkbox(parent, label, checked) {
    const wrap = el('label', 'am-check');
    const node = input('checkbox'); node.checked = Boolean(checked);
    wrap.append(node, el('span', null, label));
    parent.append(wrap);
    return node;
  }

  /* ------------------------------------------------------ envio da mídia */

  /**
   * Manda o arquivo em blocos pelos endpoints administrativos. Os bytes passam
   * pelo nosso backend, que fala com o Storage privado: o navegador nunca vê a
   * chave do Supabase nem a URL de upload.
   */
  async function sendFile(file, say) {
    // Etapas visíveis: preparando -> enviando (%) -> processando -> concluído.
    say('Preparando o arquivo…', 0);
    file = await AylaImageTools.post(file);
    if (file.size > uploadMax) throw new Error(`Arquivo acima do limite de ${Math.round(uploadMax / 1024 / 1024)} MB.`);
    let upload = await api('/uploads', 'POST', { size: file.size, mime: file.type });
    while (!upload.complete) {
      const pct = Math.round(upload.offset / file.size * 100);
      say(`Enviando mídia: ${pct}%`, pct);
      const part = file.slice(upload.offset, Math.min(file.size, upload.offset + upload.chunkSize));
      const sent = await api('/uploads/' + upload.id, 'PATCH', part,
        { 'Content-Type': 'application/octet-stream', 'upload-offset': String(upload.offset) });
      upload = { ...upload, ...sent };
    }
    say('Processando a mídia…', 100);
    return upload.id;
  }

  /* --------------------------------------------------- teaser de vídeo */

  const TEASER = { seconds: 7, height: 240, fps: 15, blur: 7 };
  /** Mesmo teto do servidor (post-media.js): a tela não promete o que o backend recusa. */
  const MAX_MEDIA = 10;

  /** O navegador desta máquina consegue gravar um teaser? */
  function canRecord() {
    return typeof MediaRecorder !== 'undefined'
      && typeof HTMLCanvasElement.prototype.captureStream === 'function'
      && (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') || MediaRecorder.isTypeSupported('video/webm;codecs=vp8') || MediaRecorder.isTypeSupported('video/webm'));
  }
  function recorderMime() {
    for (const type of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  /**
   * Gera o teaser da HOME a partir do arquivo escolhido.
   *
   * O vídeo original NUNCA vai para a HOME. O que sai daqui é outro arquivo:
   * ~5 segundos, 240p, SEM faixa de áudio e com o desfoque desenhado quadro a
   * quadro dentro do canvas — ou seja, gravado no próprio arquivo, não
   * aplicado por CSS que qualquer um desliga no inspetor.
   *
   * Só o canvas entra no MediaRecorder. O áudio do original não é lido, não é
   * conectado e não existe na faixa gravada.
   *
   * Sem MediaRecorder no navegador, devolve `null` e o post fica só com o
   * pôster desfocado que já existia. Em nenhum caso o original é usado.
   */
  async function deriveTeaser(file, say) {
    if (!file.type.startsWith('video/') || !canRecord()) return null;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    try {
      video.muted = true; video.defaultMuted = true; video.volume = 0;
      video.playsInline = true; video.preload = 'auto'; video.src = url;
      await once(video, 'loadeddata');
      const width = video.videoWidth, height = video.videoHeight;
      if (!width || !height) return null;

      const canvas = document.createElement('canvas');
      const scale = Math.min(1, TEASER.height / height);
      canvas.width = Math.max(2, Math.round(width * scale / 2) * 2);
      canvas.height = Math.max(2, Math.round(height * scale / 2) * 2);
      const ctx = canvas.getContext('2d');

      // Começa um pouco depois do zero: o primeiro quadro costuma ser escuro.
      const start = Math.min(1, Math.max(0, (video.duration || TEASER.seconds) / 6));
      try { video.currentTime = start; await once(video, 'seeked'); } catch (_) { /* o começo serve */ }

      const stream = canvas.captureStream(TEASER.fps);
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: recorderMime(), videoBitsPerSecond: 320000 });
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      const finished = new Promise(resolve => { recorder.onstop = resolve; });

      let painting = true;
      const paint = () => {
        if (!painting) return;
        // O desfoque é desenhado AQUI: entra nos pixels do arquivo gravado.
        ctx.filter = `blur(${TEASER.blur}px)`;
        try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch (_) { /* quadro perdido */ }
        requestAnimationFrame(paint);
      };
      recorder.start();
      paint();
      try { await video.play(); } catch (_) { /* sem autoplay, os seeks ainda pintam */ }
      say && say('Gerando o teaser da HOME…');

      const limit = Math.min(TEASER.seconds, Math.max(0.5, (video.duration || TEASER.seconds) - start));
      await new Promise(resolve => setTimeout(resolve, limit * 1000));
      painting = false;
      video.pause();
      recorder.stop();
      stream.getTracks().forEach(track => track.stop());
      await finished;

      if (!chunks.length) return null;
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (!blob.size || blob.size > 3 * 1024 * 1024) return null;
      return new File([blob], 'teaser.webm', { type: 'video/webm' });
    } catch (_) {
      return null;                       // falhou a derivação: fica sem teaser
    } finally {
      video.removeAttribute('src'); video.load();
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Mostra no painel o teaser que está valendo na HOME.
   *
   * Carrega pela MESMA rota pública do visitante, então o que aparece aqui é
   * exatamente o que ele vê: 5 segundos, sem som, já desfocado no arquivo.
   * Publicação de foto, sem teaser ou fora da HOME não mostra nada.
   */
  function teaserPreview(parent, post) {
    if (!post || post.type !== 'video' || !post.show_as_preview) return null;
    const wrap = el('div', 'am-field am-teaser');
    wrap.append(el('span', null, 'Teaser da HOME'));
    const video = document.createElement('video');
    video.src = BASE + '/api/home/preview-video/' + encodeURIComponent(post.id);
    video.muted = true; video.playsInline = true; video.preload = 'metadata';
    video.loop = true; video.controls = false;
    video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
    const note = el('small', null, `Teaser derivado de ~${TEASER.seconds}s, sem áudio e já desfocado. O vídeo completo não vai para a HOME.`);
    // Sem teaser gravado ainda, a rota devolve 404: aí o aviso troca de texto.
    video.addEventListener('error', () => {
      video.remove();
      note.textContent = 'Ainda sem teaser. Use "Trocar mídia" e escolha o vídeo de novo para gerar um.';
    }, { once: true });
    video.addEventListener('loadeddata', () => { video.play().catch(() => { video.controls = true; }); }, { once: true });
    wrap.append(video, note);
    parent.append(wrap);
    return video;
  }

  /** Manda o teaser pela mesma esteira de upload, para a pasta de prévias. */
  async function sendTeaser(file, say) {
    let upload = await api('/uploads', 'POST', { size: file.size, mime: file.type, purpose: 'preview' });
    while (!upload.complete) {
      say && say(`Enviando o teaser: ${Math.round(upload.offset / file.size * 100)}%`);
      const part = file.slice(upload.offset, Math.min(file.size, upload.offset + upload.chunkSize));
      const sent = await api('/uploads/' + upload.id, 'PATCH', part,
        { 'Content-Type': 'application/octet-stream', 'upload-offset': String(upload.offset) });
      upload = { ...upload, ...sent };
    }
    return upload.id;
  }

  /** Amostra minúscula para a prévia da HOME, gerada aqui e validada no servidor. */
  function once(node, event) {
    return new Promise((resolve, reject) => {
      node.addEventListener(event, resolve, { once: true });
      node.addEventListener('error', () => reject(new Error('Não consegui ler esta mídia.')), { once: true });
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
        try { video.currentTime = Math.min(1, Math.max(0, (video.duration || 2) / 4)); await once(video, 'seeked'); } catch (_) { /* primeiro quadro serve */ }
        source = video; width = video.videoWidth; height = video.videoHeight;
      } else {
        const image = document.createElement('img');
        image.src = url; await once(image, 'load');
        source = image; width = image.naturalWidth; height = image.naturalHeight;
      }
      if (!width || !height) throw new Error('Mídia sem dimensões legíveis.');
      return AylaImageTools.preview(source, width, height);
    } finally { URL.revokeObjectURL(url); }
  }

  /* ------------------------------------------------------------- publicação */

  /** Campo vazio vira 0; o resto o servidor recusa se não for inteiro válido. */
  function likesValue(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return 0;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) throw new Error('Curtidas exibidas devem ser um número inteiro a partir de zero.');
    return value;
  }

  /**
   * A LISTA de mídias da publicação.
   *
   * Uma foto continua sendo uma foto: a lista abre com um item só e o formulário
   * parece o de sempre. "Adicionar foto ou vídeo" acrescenta linhas, e cada
   * linha tem o seu próprio enquadramento, o seu botão de trocar arquivo, de
   * remover e as setas de ordem — é a ordem daqui que vira a ordem do carrossel.
   *
   * Nada é enviado enquanto a criadora mexe: os arquivos só sobem no Salvar, e
   * cada vídeo só gera teaser se a publicação estiver marcada para a HOME.
   */
  function mediaList(parent, post, context) {
    const existing = Array.isArray(post?.media) && post.media.length
      ? post.media
      : post ? [{ id: 'item-' + post.id, type: post.type, crop: post.crop_data ? JSON.parse(post.crop_data) : null }] : [];
    const rows = [];

    const wrap = el('div', 'am-field am-media');
    wrap.append(el('span', null, 'Mídias da publicação'));
    const list = el('div', 'am-media-list');
    wrap.append(list);
    const add = button('+ Adicionar foto ou vídeo', () => pick(), 'am-btn am-media-add');
    const hint = el('small', null, `Arraste no feed para ver uma a uma. Até ${MAX_MEDIA} mídias · JPG, PNG, WebP, MP4 ou WebM.`);
    wrap.append(add, hint);
    parent.append(wrap);

    // Um <input file> escondido e reutilizado: abrir o seletor não pode
    // depender de um campo visível por linha, senão o formulário vira uma pilha.
    const picker = input('file');
    picker.accept = 'image/jpeg,image/png,image/webp,video/mp4,video/webm';
    picker.multiple = true;
    picker.className = 'am-hidden-file';
    wrap.append(picker);
    let pickTarget = null;
    picker.addEventListener('change', () => {
      const files = [...picker.files];
      picker.value = '';
      if (!files.length) return;
      if (pickTarget) { swapFile(pickTarget, files[0]); pickTarget = null; return; }
      for (const file of files) {
        if (rows.length >= MAX_MEDIA) { context.say(`No máximo ${MAX_MEDIA} mídias por publicação.`); break; }
        addRow({ file });
      }
      redraw();
    });
    function pick(row) { pickTarget = row || null; picker.multiple = !row; picker.click(); }

    function swapFile(row, file) {
      row.file = file;
      row.type = file.type.startsWith('video/') ? 'video' : 'image';
      row.framing.setFile(file);
      row.label.textContent = rowTitle(row);
    }
    const rowTitle = row => (row.type === 'video' ? 'Vídeo' : 'Foto') + (row.file ? ' · novo arquivo' : '');

    function addRow(spec) {
      const card = el('div', 'am-media-item');
      const head = el('div', 'am-media-head');
      const position = el('span', 'am-media-pos');
      const label = el('strong', null, '');
      head.append(position, label);
      card.append(head);

      const row = {
        id: spec.id || null,
        type: spec.type || (spec.file && spec.file.type.startsWith('video/') ? 'video' : 'image'),
        file: spec.file || null,
        card, label, position
      };

      row.framing = AylaFrame.editor(card, {
        src: spec.id && post ? BASE + '/api/admin/posts/' + encodeURIComponent(post.id) + '/media/' + encodeURIComponent(spec.id) : '',
        type: row.type,
        crop: spec.crop || null,
        label: 'Enquadramento desta mídia'
      });
      if (spec.file) row.framing.setFile(spec.file);

      const tools = el('div', 'am-media-tools');
      tools.append(
        button('Trocar', () => pick(row), 'am-btn am-btn-sm'),
        button('↑', () => move(row, -1), 'am-btn am-btn-sm am-media-move'),
        button('↓', () => move(row, 1), 'am-btn am-btn-sm am-media-move'),
        button('Remover', () => remove(row), 'am-btn am-btn-sm am-media-remove')
      );
      card.append(tools);
      list.append(card);
      rows.push(row);
      row.label.textContent = rowTitle(row);
      return row;
    }

    function move(row, direction) {
      const index = rows.indexOf(row);
      const target = index + direction;
      if (target < 0 || target >= rows.length) return;
      rows.splice(index, 1);
      rows.splice(target, 0, row);
      redraw();
    }
    function remove(row) {
      if (rows.length === 1) { context.say('A publicação precisa de pelo menos uma mídia.'); return; }
      row.framing.destroy();
      row.card.remove();
      rows.splice(rows.indexOf(row), 1);
      redraw();
    }
    function redraw() {
      rows.forEach((row, index) => {
        list.append(row.card);                       // reordena sem recriar nada
        row.position.textContent = String(index + 1);
        row.label.textContent = rowTitle(row);
        row.card.classList.toggle('is-first', index === 0);
      });
      add.disabled = rows.length >= MAX_MEDIA;
      wrap.classList.toggle('is-carousel', rows.length > 1);
    }

    existing.forEach(item => addRow({ id: item.id, type: item.type, crop: item.crop }));
    if (!rows.length) addRow({ type: 'image' });
    redraw();

    return {
      count: () => rows.length,
      hasNewFile: () => rows.some(row => row.file),
      destroy: () => rows.forEach(row => row.framing.destroy()),
      /** Sobe o que for novo e devolve a lista final, na ordem da tela. */
      async collect(say, wantsHome) {
        const items = [];
        for (const [index, row] of rows.entries()) {
          const item = { crop: row.framing.get() };
          if (row.id && !row.file) item.id = row.id;
          if (row.file) {
            say?.(`Enviando mídia ${index + 1} de ${rows.length}…`);
            if (row.id) item.id = row.id;
            try { item.preview_image = await derive(row.file, item.crop); }
            catch (_) { say?.(`Não consegui gerar a amostra da mídia ${index + 1}.`); }
            item.uploadId = await sendFile(row.file, say);
            // Cada vídeo do carrossel tem o SEU teaser de ~5s.
            if (wantsHome && row.file.type.startsWith('video/')) {
              const teaser = await deriveTeaser(row.file, say);
              if (teaser) item.previewUploadId = await sendTeaser(teaser, say);
              else say?.('Sem teaser de vídeo neste navegador: a HOME mostra o pôster desfocado.');
            }
          }
          items.push(item);
        }
        return items;
      }
    };
  }

  function postSheet(post) {
    const editing = Boolean(post);
    openSheet(editing ? 'Editar publicação' : 'Nova publicação', context => {
      if (storage !== 'supabase') context.say('O Storage do Supabase não está configurado: o envio de mídia vai falhar.');
      context.body.prepend(statusChips(post, 'am-chips am-chips-sheet'));

      const conteudo = section(context.body, 'Conteúdo');
      const medias = mediaList(conteudo, post, context);

      const caption = document.createElement('textarea');
      caption.rows = 4; caption.maxLength = 4000; caption.value = post?.caption || '';
      caption.placeholder = 'Escreva a legenda…';
      field(conteudo, 'Legenda', caption);

      const visibilidade = section(context.body, 'Visibilidade');
      const published = checkbox(visibilidade, 'Publicado', post ? post.published : true);
      // Publicação NOVA já nasce aparecendo na HOME; edição mantém o que estava.
      const preview = checkbox(visibilidade, 'Mostrar como prévia na HOME', post ? post.show_as_preview : true);
      // Vídeo na HOME: mostra aqui o MESMO teaser derivado que o visitante vê,
      // para a criadora conferir o trecho antes de deixar no ar.
      teaserPreview(visibilidade, post);

      const numeros = section(context.body, 'Ordem e números');
      const order = input('number', String(post?.sort_order ?? (posts.length ? Math.max(...posts.map(p => p.sort_order)) + 10 : 0)));
      order.min = '-1000000'; order.max = '1000000'; order.step = '1';
      field(numeros, 'Ordem no feed', order, 'Número menor aparece primeiro.');

      // Número mostrado no coração. É o que você digita — não muda sozinho a
      // cada visita. As curtidas reais dos assinantes entram por cima dele.
      const likes = input('number', String(post?.likes_count ?? 0));
      likes.min = '0'; likes.max = '100000000'; likes.step = '1'; likes.inputMode = 'numeric';
      field(numeros, 'Curtidas exibidas', likes, 'Número inteiro. Vazio conta como 0.');

      // Ações: o botão principal diz o que vai acontecer.
      context.save.textContent = editing ? 'Atualizar' : (published.checked ? 'Publicar' : 'Salvar rascunho');
      const sincronizar = () => { context.save.textContent = editing ? 'Atualizar' : (published.checked ? 'Publicar' : 'Salvar rascunho'); };
      published.addEventListener('change', sincronizar);
      if (!editing) {
        const rascunho = button('Salvar rascunho', () => {
          published.checked = false; sincronizar();
          context.sheet.requestSubmit();
        }, 'am-btn am-btn-sm am-btn-quiet');
        rascunho.type = 'button';
        context.actions.prepend(rascunho);
      }
      if (editing) {
        const excluir = button('Excluir', () => { context.close(); deleteSheet(post); }, 'am-btn am-btn-sm am-btn-quiet am-menu-danger');
        excluir.type = 'button';
        context.actions.prepend(excluir);
      }
      context.state = { caption, order, published, preview, likes, medias };
    }, async context => {
      const { caption, order, published, preview, likes, medias } = context.state;
      const items = await medias.collect(context.say, preview.checked);
      const body = {
        caption: caption.value,
        sort_order: Number(order.value),
        published: published.checked,
        show_as_preview: preview.checked,
        likes_count: likesValue(likes.value),
        // O enquadramento do post acompanha o do primeiro item: é ele que
        // continua preenchendo as colunas antigas nesta fase.
        crop: items[0].crop,
        items,
        version: post?.version
      };
      // Só mudou o enquadramento de uma mídia que já existia? A amostra da
      // HOME é refeita a partir do arquivo atual, sem reenviar nada.
      if (post && preview.checked && !medias.hasNewFile()) {
        const first = items[0];
        const alvo = first.id ? '/api/admin/posts/' + post.id + '/media/' + encodeURIComponent(first.id)
          : '/api/admin/posts/' + post.id + '/media';
        const response = await fetch(BASE + alvo);
        if (response.ok) {
          try { body.preview_image = await derive(await response.blob(), first.crop); }
          catch (_) { context.say('Não consegui atualizar a amostra da HOME.'); }
        }
      }
      await api(editing ? '/posts/' + post.id : '/posts', editing ? 'PUT' : 'POST', body);
      medias.destroy();
      context.close();
      toast(editing ? 'Publicação atualizada.' : 'Publicação criada.');
      await reload();
    });
  }

  /**
   * Atalhos de UMA coisa só.
   *
   * São a mesma chamada de "Editar publicação", com um campo apenas. Os outros
   * valores viajam como estão no registro, então trocar a legenda não mexe na
   * ordem, e mexer nas curtidas não republica nada.
   */
  function quickSheet(post, title, build, collect, done) {
    openSheet(title, context => { context.state = build(context); },
      async context => {
        const changes = await collect(context);
        await api('/posts/' + post.id, 'PUT', {
          caption: post.caption,
          sort_order: post.sort_order,
          published: Boolean(post.published),
          show_as_preview: Boolean(post.show_as_preview),
          likes_count: Number(post.likes_count || 0),
          version: post.version,
          ...changes
        });
        context.close();
        toast(done);
        await reload();
      });
  }

  function mediaSheet(post) {
    quickSheet(post, 'Trocar mídia', context => {
      const file = input('file');
      file.accept = 'image/jpeg,image/png,image/webp,video/mp4,video/webm';
      field(context.body, 'Nova foto ou vídeo', file, `Substitui o arquivo atual · até ${Math.round(uploadMax / 1024 / 1024)} MB.`);
      if (storage !== 'supabase') context.say('O Storage do Supabase não está configurado: o envio de mídia vai falhar.');
      return { file };
    }, async context => {
      const chosen = context.state.file.files[0];
      if (!chosen) throw new Error('Escolha o arquivo novo.');
      const changes = {};
      // A amostra antiga mostrava o arquivo antigo: é refeita junto.
      try { changes.preview_image = await derive(chosen); }
      catch (_) { context.say('Não consegui gerar a amostra da HOME desta mídia.'); }
      changes.uploadId = await sendFile(chosen, context.say);
      // O teaser antigo também era do arquivo antigo: some com ele. Quando a
      // publicação está na HOME e a mídia nova é vídeo, um teaser novo entra.
      if (post.show_as_preview && chosen.type.startsWith('video/')) {
        const teaser = await deriveTeaser(chosen, context.say);
        if (teaser) changes.previewUploadId = await sendTeaser(teaser, context.say);
      }
      return changes;
    }, 'Mídia trocada.');
  }

  function captionSheet(post) {
    quickSheet(post, 'Alterar legenda', context => {
      const caption = document.createElement('textarea');
      caption.rows = 5; caption.maxLength = 4000; caption.value = post.caption || '';
      field(context.body, 'Legenda', caption, 'Até 4.000 caracteres.');
      return { caption };
    }, context => ({ caption: context.state.caption.value }), 'Legenda salva.');
  }

  function likesSheet(post) {
    quickSheet(post, 'Alterar curtidas', context => {
      const likes = input('number', String(post.likes_count ?? 0));
      likes.min = '0'; likes.max = '100000000'; likes.step = '1'; likes.inputMode = 'numeric';
      field(context.body, 'Curtidas exibidas', likes, 'Número inteiro. Vazio conta como 0.');
      return { likes };
    }, context => ({ likes_count: likesValue(context.state.likes.value) }), 'Curtidas atualizadas.');
  }

  /* ----------------------------------------------------------------- perfil */

  async function profileSheet() {
    const current = await api('/profile');
    openSheet('Editar perfil', context => {
      const name = field(context.body, 'Nome', input('text', current.name || ''));
      name.maxLength = 80;
      const username = field(context.body, 'Username', input('text', current.username || ''), 'Começa com @.');
      username.maxLength = 80;
      const bio = document.createElement('textarea');
      bio.rows = 5; bio.maxLength = 4000; bio.value = current.bio || '';
      field(context.body, 'Bio', bio);
      const avatar = input('file'); avatar.accept = 'image/jpeg,image/png,image/webp';
      field(context.body, 'Avatar', avatar, 'Sem escolher, mantém o atual.');
      const avatarFrame = AylaFrame.editor(context.body,{src:current.avatar,crop:current.avatarCrop,role:'avatar',label:'Enquadrar avatar'});
      avatar.addEventListener('change',()=>{if(avatar.files[0])avatarFrame.setFile(avatar.files[0]);});
      const cover = input('file'); cover.accept = 'image/jpeg,image/png,image/webp';
      field(context.body, 'Capa', cover, 'Escolha o enquadramento abaixo.');
      const coverFrame = AylaFrame.editor(context.body,{src:current.cover,crop:current.coverCrop,role:'cover',label:'Enquadrar capa'});
      cover.addEventListener('change',()=>{if(cover.files[0])coverFrame.setFile(cover.files[0]);});
      context.state = { name, username, bio, avatar, cover, avatarFrame, coverFrame };
    }, async context => {
      const { name, username, bio, avatar, cover } = context.state;
      const body = { name: name.value, username: username.value, bio: bio.value, version: current.version, avatarCrop:context.state.avatarFrame.get(), coverCrop:context.state.coverFrame.get() };
      if (avatar.files[0]) body.avatarUploadId = await sendFile(await AylaImageTools.profile(avatar.files[0], 'avatar'), context.say);
      if (cover.files[0]) body.coverUploadId = await sendFile(await AylaImageTools.profile(cover.files[0], 'cover'), context.say);
      await api('/profile', 'PUT', body);
      context.close();
      try { sessionStorage.setItem('ayla.profile.changed', '1'); } catch (_) {}
      toast('Perfil salvo. Recarregando…');
      setTimeout(() => location.reload(), 700);
    });
  }

  /* --------------------------------------------------- menu de cada post */

  function closeMenus() {
    document.querySelectorAll('.am-menu.is-open').forEach(m => m.classList.remove('is-open'));
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.am-menu')) closeMenus();
  });

  async function move(post, direction) {
    const ordered = posts.filter(p => !p.archived);
    const index = ordered.findIndex(p => p.id === post.id);
    const neighbour = ordered[index + direction];
    if (!neighbour) return toast('Já está na ponta.');
    const payload = p => ({ caption: p.caption, published: Boolean(p.published), show_as_preview: Boolean(p.show_as_preview), version: p.version });
    if (neighbour.sort_order === post.sort_order) {
      await api('/posts/' + post.id, 'PUT', { ...payload(post), sort_order: post.sort_order + direction });
    } else {
      await api('/posts/' + post.id, 'PUT', { ...payload(post), sort_order: neighbour.sort_order });
      await api('/posts/' + neighbour.id, 'PUT', { ...payload(neighbour), sort_order: post.sort_order });
    }
    toast('Ordem atualizada.');
    await reload();
  }

  /**
   * Confirmação da exclusão permanente.
   *
   * É a única ação do painel sem volta, então ela não pode custar o mesmo
   * toque que "Arquivar": em vez de um aviso do navegador, uma folha que diz
   * o que vai acontecer e um botão que só liga depois da caixa marcada.
   * O servidor exige a mesma confirmação, então nem uma chamada solta apaga.
   */
  function deleteSheet(post) {
    openSheet('Excluir permanentemente', context => {
      const box = el('div', 'am-danger-box');
      box.append(el('strong', null, 'Tem certeza? Essa ação não poderá ser desfeita.'));
      box.append(el('p', null, 'A publicação sai da HOME e da área VIP, o registro e as curtidas são apagados, e o arquivo sai do Storage privado se nenhuma outra publicação usar ele.'));
      box.append(el('p', null, 'Para tirar do ar sem perder nada, feche aqui e use "Arquivar".'));
      context.body.append(box);
      const agreed = checkbox(context.body, 'Entendi e quero excluir para sempre', false);
      context.save.textContent = 'Excluir';
      context.save.classList.add('am-btn-danger');
      context.save.disabled = true;
      agreed.addEventListener('change', () => { context.save.disabled = !agreed.checked; });
      context.state = { agreed };
    }, async context => {
      if (!context.state.agreed.checked) throw new Error('Marque a confirmação para excluir.');
      const result = await api('/posts/' + post.id + '/permanent', 'DELETE', { version: post.version, confirm: 'EXCLUIR' });
      context.close();
      toast(result.storage === 'pending' ? 'Publicação excluída. Limpeza da mídia pendente no painel.' : 'Publicação excluída permanentemente.');
      await reload();
    });
  }

  function menuFor(post) {
    const menu = el('div', 'am-menu');
    const trigger = el('button', 'am-menu-trigger', '⋮');
    trigger.type = 'button';
    trigger.setAttribute('aria-label', 'Ações da publicação');
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const open = menu.classList.contains('is-open');
      closeMenus();
      menu.classList.toggle('is-open', !open);
    });
    const list = el('div', 'am-menu-list');
    const payload = { caption: post.caption, sort_order: post.sort_order, published: Boolean(post.published), show_as_preview: Boolean(post.show_as_preview), version: post.version };
    const item = (label, action) => list.append(button(label, action, 'am-menu-item'));

    item('Editar publicação', () => { closeMenus(); postSheet(post); });
    item('Trocar mídia', () => { closeMenus(); postSheet(post); });
    item('Alterar legenda', () => { closeMenus(); captionSheet(post); });
    item('Alterar curtidas', () => { closeMenus(); likesSheet(post); });
    item(post.show_as_preview ? 'Tirar da HOME' : 'Mostrar na HOME', async () => {
      if (!post.show_as_preview && !post.has_preview) throw new Error('Sem amostra ainda. Abra Trocar mídia e escolha o arquivo de novo.');
      await api('/posts/' + post.id, 'PUT', { ...payload, show_as_preview: !post.show_as_preview });
      toast('Prévia da HOME atualizada.'); await reload();
    });
    item(post.published ? 'Despublicar' : 'Publicar', async () => {
      await api('/posts/' + post.id, 'PUT', { ...payload, published: !post.published });
      toast(post.published ? 'Despublicada.' : 'Publicada.'); await reload();
    });
    item('Mover para cima', () => move(post, -1));
    item('Mover para baixo', () => move(post, 1));
    const archive = button('Arquivar', async () => {
      if (!confirm('Arquivar esta publicação? Ela sai do feed, a mídia é preservada e dá para restaurar depois.')) return;
      await api('/posts/' + post.id, 'DELETE', { version: post.version });
      toast('Publicação arquivada.'); await reload();
    }, 'am-menu-item am-menu-danger');
    list.append(archive);
    list.append(button('Excluir permanentemente',()=>{closeMenus();deleteSheet(post);},'am-menu-item am-menu-danger'));

    menu.append(trigger, list);
    return menu;
  }

  /* ------------------------------------------------- encaixe nas duas telas */

  const isVip = location.pathname.replace(/\/+$/, '') === '/vip';

  /**
   * Casa os cartões do feed na tela com os registros do painel.
   *
   * Prioriza o id que o próprio cartão carrega (`data-post-id`) — é exato e não
   * depende de rascunho, ordem ou filtro de aba. A contagem por posição fica só
   * como rede de segurança para cartão antigo que ainda não tem id.
   */
  function decorateFeed() {
    document.querySelectorAll('.am-menu').forEach(m => m.remove());
    const cards = isVip
      ? [...document.querySelectorAll('.vip-post')]
      : [...document.querySelectorAll('.preview-post')];
    if (!cards.length) return;
    const alive = posts.filter(p => !p.archived);
    // Na revisão do /vip o rascunho também aparece; na HOME, só a prévia marcada.
    const source = isVip ? alive : alive.filter(p => p.published && p.show_as_preview);
    const byId = new Map(alive.map(p => [String(p.id), p]));
    let position = 0;
    cards.forEach(card => {
      const marked = card.dataset.postId ? byId.get(String(card.dataset.postId)) : null;
      const post = marked || source[position++];
      if (!post) return;
      const head = card.querySelector(isVip ? '.vip-post-head' : '.post-header');
      // A criadora vê o estado sem abrir o menu: RASCUNHO, PUBLICADO, PÚBLICO/SÓ VIP.
      if (head) head.append(statusChips(post), menuFor(post));
    });
  }

  function bar(email) {
    const strip = el('div', 'am-bar');
    strip.id = 'amBar';
    const tag = el('span', 'am-bar-tag', 'Modo administrador');
    const actions = el('div', 'am-bar-actions');
    actions.append(
      button('Nova publicação', () => postSheet(null), 'am-btn am-btn-primary am-btn-sm'),
      button('Editar perfil', () => profileSheet(), 'am-btn am-btn-sm'),
      // Sem comprar nada: o /vip reconhece a sessão administrativa e abre em
      // modo revisão. Na própria área VIP o botão volta para a HOME.
      button(isVip ? 'Ver página inicial' : 'Ver área VIP', () => { location.assign(isVip ? '/' : '/vip'); }, 'am-btn am-btn-sm'),
      button('Sair', async () => {
        await api('/logout', 'POST', {});
        location.reload();
      }, 'am-btn am-btn-sm am-btn-quiet')
    );
    strip.append(tag, actions);
    if (email) strip.title = email;
    document.body.classList.add('am-on');
    document.body.prepend(strip);
    // A barra quebra em duas linhas em telas estreitas; o recuo acompanha.
    const fit = () => document.body.style.setProperty('--am-bar-height', strip.offsetHeight + 'px');
    fit();
    window.addEventListener('resize', fit);
    if (window.ResizeObserver) new ResizeObserver(fit).observe(strip);

    const floating = button('+', () => postSheet(null), 'am-fab');
    floating.setAttribute('aria-label', 'Nova publicação');
    document.body.append(floating);
  }

  /** Botões de troca rápida sobre a capa e o avatar. */
  function profileHandles() {
    const cover = document.querySelector(isVip ? '.vip-cover' : '.cover-wrap');
    if (cover && !cover.querySelector('.am-edit')) {
      const edit = button('✏ Alterar capa', () => profileSheet(), 'am-edit am-edit-cover');
      cover.append(edit);
    }
    const avatar = document.querySelector(isVip ? '.vip-avatar-wrap' : '.avatar-wrap');
    if (avatar && !avatar.querySelector('.am-edit')) {
      const edit = button('✏', () => profileSheet(), 'am-edit am-edit-avatar');
      edit.setAttribute('aria-label', 'Alterar avatar');
      avatar.append(edit);
    }
  }

  async function reload(refresh = true) {
    if (refresh) { location.reload(); return; }
    const data = await api('/posts');
    posts = data.posts || [];
    decorateFeed();
  }

  /* -------------------------------------------------------------- entrada */

  async function start() {
    let me;
    try {
      if (window.AylaAdminSession) me = await window.AylaAdminSession;
      else {
        const response = await fetch(BASE + '/api/admin/me', { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        me = await response.json();
      }
    } catch (_) { return; }            // sem backend, a página fica como está
    if (!me || !me.admin) return;      // visitante e assinante: nada é desenhado

    csrf = me.csrf || '';
    try {
      const session = await api('/session');
      uploadMax = session.uploadMaxBytes; storage = session.storage;
    } catch (_) { uploadMax = 250 * 1024 * 1024; }

    bar(me.email);
    profileHandles();
    try { await reload(false); } catch (error) { toast(error.message); }
    // O feed do /vip e as prévias da HOME são montados por JS; reencaixa depois.
    setTimeout(decorateFeed, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
