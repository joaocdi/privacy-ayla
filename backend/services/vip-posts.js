const crypto = require('crypto');
const { getDb, transaction } = require('../db/database');
const legacy = require('../vip-content');
const media = require('./vip-media');
const previewImage = require('./preview-image');
const crop = require('./crop');
const cleanup = require('./media-cleanup');
const previewVideo = require('./preview-video');
const postMedia = require('./post-media');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_HOME_PREVIEWS = 12;

async function source(db = null) {
  return (await (db || await getDb()).get("SELECT source FROM vip_content_settings WHERE id='ayla'"))?.source || 'legacy';
}
async function setSource(value) {
  if (!['legacy', 'managed'].includes(value)) throw fail('Modo de feed inválido.');
  await (await getDb()).run("INSERT INTO vip_content_settings(id,source) VALUES ('ayla',?) ON CONFLICT(id) DO UPDATE SET source=excluded.source", value);
}
// The panel list never carries preview_image itself: it only needs to know
// whether the derivative exists, and the payload stays small with many posts.
const LIST_COLUMNS = `id,creator_id,type,media_path,media_driver,caption,sort_order,published,archived,
  show_as_preview,likes_count,crop_data,version,created_at,updated_at,
  CASE WHEN preview_image IS NULL OR preview_image='' THEN 0 ELSE 1 END AS has_preview`;
async function list() {
  const db = await getDb();
  const rows = await db.all(`SELECT ${LIST_COLUMNS} FROM vip_posts WHERE creator_id='ayla' ORDER BY sort_order,created_at,id`);
  // O painel precisa da lista de mídias para desenhar o editor do carrossel.
  // Vai a forma resumida: id, tipo, enquadramento e se já tem derivada — o
  // caminho do arquivo continua sem sair do servidor.
  const full = await db.all(`SELECT p.id AS pid, p.media_path, p.type, p.media_driver, p.crop_data, p.preview_image, p.preview_video
    FROM vip_posts p WHERE p.creator_id='ayla'`);
  const byId = new Map(full.map(p => [p.pid, { id: p.pid, media_path: p.media_path, type: p.type, media_driver: p.media_driver, crop_data: p.crop_data, preview_image: p.preview_image, preview_video: p.preview_video }]));
  return Promise.all(rows.map(async row => ({
    ...row,
    media: (await postMedia.listFor(db, byId.get(row.id) || row)).map(postMedia.present)
  })));
}
/**
 * Amostra bloqueada da HOME.
 *
 * Devolve SOMENTE a derivada minúscula e a legenda. `media_path` nunca sai
 * daqui: o visitante não é assinante e não recebe nada que leve ao original.
 */
async function homePreviews({ limit = MAX_HOME_PREVIEWS, offset = 0 } = {}) {
  if (await source() !== 'managed') return [];
  const db = await getDb();
  const rows = await db.all(`SELECT id,type,caption,preview_image,crop_data,preview_video,likes_count,
    (SELECT COUNT(*) FROM vip_post_likes l WHERE l.post_id=vip_posts.id) AS likes FROM vip_posts
    WHERE creator_id='ayla' AND published=1 AND archived=0 AND show_as_preview=1 AND preview_image IS NOT NULL AND preview_image<>''
    ORDER BY sort_order,created_at,id`);
  // Página do feed público: o visitante recebe as primeiras e busca o resto
  // ao chegar perto do fim. O teto continua sendo MAX_HOME_PREVIEWS.
  const start = Math.max(0, Math.min(Number(offset) || 0, MAX_HOME_PREVIEWS));
  const size = Math.max(1, Math.min(Number(limit) || MAX_HOME_PREVIEWS, MAX_HOME_PREVIEWS));
  const disponiveis = rows.slice(0, MAX_HOME_PREVIEWS);
  const chosen = disponiveis.slice(start, start + size);
  const total = disponiveis.length;
  // `fallback: false`: esta função responde ao VISITANTE e por isso não lê,
  // nem indiretamente, o caminho do arquivo original.
  const byPost = await postMedia.listForMany(db, chosen, { fallback: false });
  const montados = chosen.map(row => {
    // Um item por mídia, cada um com a SUA derivada. A foto entrega a amostra
    // minúscula embutida; o vídeo entrega a rota do teaser dele. Em nenhum
    // caso sai caminho de arquivo original ou link assinado.
    const items = (byPost.get(row.id) || [])
      .filter(item => item.preview_image || previewVideo.isPreviewPath(item.preview_video))
      .map(item => ({
        id: item.id,
        type: item.type,
        crop: crop.read(item.crop_data),
        preview: previewImage.dataUri(item.preview_image),
        teaser: previewVideo.isPreviewPath(item.preview_video)
          ? `/api/home/preview-video/${encodeURIComponent(row.id)}/${encodeURIComponent(item.id)}` : null
      }));
    return {
      id: row.id, likes_count: Number(row.likes_count || 0) + Number(row.likes || 0), type: row.type, caption: row.caption || '', crop: crop.read(row.crop_data),
      preview: previewImage.dataUri(row.preview_image),
      // O caminho do teaser NÃO sai daqui: sai só a rota que o entrega, e ela
      // só conhece a derivada. O `media_path` do original nunca é consultado.
      teaser: previewVideo.isPreviewPath(row.preview_video) ? `/api/home/preview-video/${encodeURIComponent(row.id)}` : null,
      teaserSeconds: previewVideo.SECONDS,
      items
    };
  });
  // `total` deixa o navegador saber se ainda há página para buscar.
  return Object.assign(montados, { total });
}
/**
 * O caminho do teaser de UMA publicação, para a rota pública da HOME.
 *
 * Mesmas condições da listagem de prévias, repetidas aqui porque esta função
 * é o que a rota pública consulta: sem `published=1 AND archived=0 AND
 * show_as_preview=1` ninguém recebe nada. `media_path` não é selecionado, e o
 * valor lido ainda passa pelo teste de prefixo antes de sair.
 */
async function homeTeaserPath(id, mediaId = null) {
  if (await source() !== 'managed') return null;
  const db = await getDb();
  const row = await db.get(`SELECT id FROM vip_posts
    WHERE id=? AND creator_id='ayla' AND published=1 AND archived=0 AND show_as_preview=1`, String(id));
  if (!row) return null;
  // Com item, o teaser é o DAQUELE item — e ele precisa pertencer a ESTE post,
  // senão o id de uma publicação liberada abriria o teaser de outra.
  if (mediaId) {
    const item = await db.get('SELECT preview_video FROM vip_post_media WHERE id=? AND post_id=?', String(mediaId), String(id));
    return previewVideo.isPreviewPath(item?.preview_video) ? item.preview_video : null;
  }
  const legacy = await db.get(`SELECT preview_video FROM vip_posts WHERE id=?`, String(id));
  return previewVideo.isPreviewPath(legacy?.preview_video) ? legacy.preview_video : null;
}

/**
 * O número que aparece no coração.
 *
 * `likes_count` é o valor que a criadora digita no painel; as curtidas reais
 * dos assinantes vivem em `vip_post_likes`. O feed mostra a soma dos dois, de
 * forma determinística: recarregar a página não muda nada, e clicar no coração
 * continua registrando a interação real por cima do número declarado.
 */
function asFeed(post) {
  return { id: post.id, type: post.type, source: post.media_path, caption: post.caption,
    likes: Number(post.likes_count || 0) + Number(post.likes || 0),
    liked: Number(post.liked || 0) > 0, realLikes: true, crop: crop.read(post.crop_data), mediaDriver: post.media_driver };
}
/**
 * Pendura as mídias do carrossel no post do feed.
 *
 * Um coração por publicação e uma legenda por publicação continuam valendo: o
 * que vira lista é só o arquivo. Post de uma mídia só sai com um item, e a
 * página desenha exatamente como antes.
 */
async function withMedia(db, rows) {
  const byPost = await postMedia.listForMany(db, rows);
  return rows.map(row => {
    const items = byPost.get(row.id) || [];
    return { ...asFeed(row), media: items.map((item, index) => ({
      id: item.id, type: item.type, source: item.media_path,
      mediaDriver: item.media_driver, crop: crop.read(item.crop_data), position: index
    })) };
  });
}
async function feed(orderId) {
  if (await source() === 'legacy') return legacy.posts.filter(p => !p.draft);
  const db = await getDb();
  return withMedia(db, await db.all(`SELECT p.*,
    (SELECT COUNT(*) FROM vip_post_likes l WHERE l.post_id=p.id) AS likes,
    (SELECT COUNT(*) FROM vip_post_likes l WHERE l.post_id=p.id AND l.order_id=?) AS liked
    FROM vip_posts p WHERE p.creator_id='ayla' AND p.published=1 AND p.archived=0
    ORDER BY p.sort_order,p.created_at,p.id`, orderId));
}
/**
 * Feed da revisão administrativa.
 *
 * Mesma montagem do feed do assinante, com uma diferença: rascunho também vem,
 * marcado com `draft: true`, para a criadora ver como a publicação vai ficar
 * antes de publicar. Não cria pedido nem entitlement — quem chama já provou ser
 * administrador.
 */
async function adminFeed() {
  if (await source() === 'legacy') return legacy.posts.map(p => ({ ...p, draft: Boolean(p.draft) }));
  const db = await getDb();
  const rows = await db.all(`SELECT p.*,
    (SELECT COUNT(*) FROM vip_post_likes l WHERE l.post_id=p.id) AS likes
    FROM vip_posts p WHERE p.creator_id='ayla' AND p.archived=0
    ORDER BY p.sort_order,p.created_at,p.id`);
  return (await withMedia(db, rows))
    .map((p, index) => ({ ...p, draft: !rows[index].published, version: rows[index].version, showAsPreview: Boolean(rows[index].show_as_preview) }));
}
/**
 * UMA mídia de um post, para as rotas que entregam bytes.
 *
 * `publishedOnly` separa os dois públicos: o assinante só alcança publicação no
 * ar; a revisão da criadora alcança rascunho também. Nos dois casos o item
 * precisa pertencer ÀQUELE post — id de item de outra publicação não resolve.
 */
async function findMediaItem(postId, mediaId, { publishedOnly = true } = {}) {
  if (await source() === 'legacy') {
    const p = legacy.posts.find(x => String(x.id) === String(postId) && (!publishedOnly || !x.draft));
    return p ? { type: p.type, source: p.source, mediaDriver: media.driverName() } : null;
  }
  const where = publishedOnly ? 'published=1 AND archived=0' : 'archived=0';
  const db = await getDb();
  const post = await db.get(`SELECT * FROM vip_posts WHERE id=? AND creator_id='ayla' AND ${where}`, String(postId));
  if (!post) return null;
  if (!mediaId) {
    const first = (await postMedia.listFor(db, post))[0];
    return first ? { type: first.type, source: first.media_path, mediaDriver: first.media_driver } : null;
  }
  const items = await postMedia.listFor(db, post);
  const item = items.find(row => String(row.id) === String(mediaId));
  return item ? { type: item.type, source: item.media_path, mediaDriver: item.media_driver } : null;
}

/** Um post para a revisão administrativa: rascunho incluído, arquivado não. */
async function findForAdmin(id) {
  if (await source() === 'legacy') return legacy.posts.find(p => String(p.id) === String(id));
  const p = await (await getDb()).get("SELECT * FROM vip_posts WHERE id=? AND creator_id='ayla' AND archived=0", String(id));
  return p ? asFeed(p) : null;
}
async function findPublished(id) {
  if (await source() === 'legacy') return legacy.posts.find(p => String(p.id) === String(id) && !p.draft);
  const p = await (await getDb()).get("SELECT * FROM vip_posts WHERE id=? AND creator_id='ayla' AND published=1 AND archived=0", String(id));
  return p ? asFeed(p) : null;
}
function validate(input) {
  if (typeof input.caption !== 'string' || input.caption.length > 4000) throw fail('Legenda deve ter até 4.000 caracteres.');
  if (!Number.isInteger(input.sort_order) || Math.abs(input.sort_order) > 1000000) throw fail('Ordem inválida.');
  if (typeof input.published !== 'boolean') throw fail('Informe publicado ou rascunho.');
  if (input.show_as_preview !== undefined && typeof input.show_as_preview !== 'boolean') throw fail('Informe se a publicação aparece como prévia na HOME.');
  if (input.likes_count !== undefined && (!Number.isInteger(input.likes_count) || input.likes_count < 0 || input.likes_count > 100000000)) {
    throw fail('Curtidas exibidas devem ser um número inteiro a partir de zero.');
  }
  // undefined = campo ausente; `undefined` de volta do normalize = valor recusado.
  if (input.preview_image !== undefined && previewImage.normalize(input.preview_image) === undefined) {
    throw fail('Prévia da HOME inválida. Selecione a mídia novamente para gerar a amostra.');
  }
  if (input.items !== undefined) {
    if (!Array.isArray(input.items)) throw fail('Lista de mídias inválida.');
    if (!input.items.length) throw fail('A publicação precisa de pelo menos uma mídia.');
    if (input.items.length > postMedia.MAX_ITEMS) throw fail(`No máximo ${postMedia.MAX_ITEMS} mídias por publicação.`);
  }
}
/**
 * Enfileira um teaser que saiu de cena.
 *
 * Só caminho de teaser entra aqui — a checagem de prefixo é a garantia de que
 * nenhum original vai parar na fila por engano. A remoção em si continua sendo
 * da `media-cleanup`, que ainda confere se alguém mais aponta para o arquivo.
 */
async function queueStaleTeaser(db, path) {
  if (!previewVideo.isPreviewPath(path)) return;
  await db.run('INSERT INTO media_deletions(media_path) VALUES (?) ON CONFLICT(media_path) DO NOTHING', path);
}

async function save(id, input, sessionId) {
  validate(input);
  // O teaser que sai de cena é apagado DEPOIS que a transação fecha: chamada de
  // rede não segura o banco, e se o Storage falhar a fila tenta de novo.
  let staleTeaser = null;
  let staleMedia = [];
  const saved = await transaction(async db => {
    await cleanup.lock(db);
    let old = null;
    if (id) {
      old = await db.get("SELECT * FROM vip_posts WHERE id=? AND creator_id='ayla'", id);
      if (!old) throw fail('Publicação não encontrada.', 404);
      if (old.archived) throw fail('Restaure a publicação antes de editar.', 409);
      if (input.version !== old.version) throw fail('Esta publicação mudou. Recarregue antes de salvar.', 409);
    }
    let asset = old && { media_path: old.media_path, type: old.type, media_driver: old.media_driver };
    if (input.uploadId) {
      const upload = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND complete=1', input.uploadId, sessionId);
      if (!upload) throw fail('Upload não concluído ou não pertence a esta sessão.');
      asset = { media_path: upload.media_path, type: upload.type, media_driver: 'supabase' };
    }
    // Carrossel: sem `uploadId` solto, quem manda nas colunas antigas é o
    // PRIMEIRO item da lista — elas continuam existindo como fallback desta
    // fase e precisam descrever a mesma mídia que abre a publicação.
    if (!input.uploadId && Array.isArray(input.items) && input.items.length) {
      const head = input.items[0];
      if (head && head.uploadId) {
        const upload = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND complete=1', head.uploadId, sessionId);
        if (!upload) throw fail('Upload não concluído ou não pertence a esta sessão.');
        asset = { media_path: upload.media_path, type: upload.type, media_driver: 'supabase' };
      } else if (head && head.id && old) {
        const existing = (await postMedia.listFor(db, old)).find(row => row.id === head.id);
        if (existing) asset = { media_path: existing.media_path, type: existing.type, media_driver: existing.media_driver };
      }
    }
    if (!asset) throw fail('Selecione e envie uma mídia.');
    await cleanup.usable(db, asset.media_path);
    const framing = input.crop === undefined ? crop.read(old?.crop_data) : crop.normalize(input.crop);
    if (input.published && (asset.media_driver !== media.driverName() || !media.exists(asset.media_path))) {
      throw fail('Mídia incompatível com o Storage ativo. Substitua a mídia antes de publicar.');
    }
    // Trocar a mídia invalida a derivada antiga: ela mostrava o arquivo anterior.
    // Com carrossel, a amostra da HOME do post é a do primeiro item.
    const head = Array.isArray(input.items) && input.items.length ? input.items[0] : null;
    const sentHead = head && head.preview_image !== undefined ? previewImage.normalize(head.preview_image) : null;
    const sent = sentHead !== null ? sentHead
      : input.preview_image === undefined ? null : previewImage.normalize(input.preview_image);
    const preview = sent !== null ? sent : input.uploadId || (head && head.uploadId) ? null : old ? old.preview_image : null;

    /* ------------------------------------------------------ teaser de vídeo */
    // Mesma regra da amostra JPEG, aplicada ao arquivo derivado: teaser novo
    // substitui, mídia trocada invalida, e foto não tem teaser nenhum.
    let teaser = old ? old.preview_video : null;
    // Com carrossel, o teaser do POST é o do primeiro item.
    const teaserField = head && head.previewUploadId !== undefined ? head.previewUploadId : input.previewUploadId;
    if (teaserField !== undefined) {
      if (teaserField === null) teaser = null;
      else {
        const sentTeaser = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND complete=1', teaserField, sessionId);
        if (!sentTeaser) throw fail('Teaser não concluído ou não pertence a esta sessão.');
        teaser = previewVideo.validateUpload(sentTeaser, { fail });
      }
    } else if (input.uploadId || (head && head.uploadId)) {
      teaser = null;                       // mídia nova, teaser velho não vale mais
    }
    if (asset.type !== 'video') teaser = null;
    // A derivada que saiu de cena vai para a fila de limpeza, nunca o original.
    if (old && old.preview_video && old.preview_video !== teaser) {
      await queueStaleTeaser(db, old.preview_video);
      staleTeaser = old.preview_video;
    }
    const showAsPreview = Boolean(input.show_as_preview);
    // Campo ausente mantém o valor atual; vazio vira zero.
    const likesCount = input.likes_count === undefined ? (old ? Number(old.likes_count || 0) : 0) : input.likes_count;
    if (showAsPreview && !preview) throw fail('Para mostrar na HOME, selecione a mídia novamente para gerar a prévia.');
    if (old) {
      const result = await db.run(`UPDATE vip_posts SET type=?,media_path=?,media_driver=?,caption=?,sort_order=?,published=?,show_as_preview=?,preview_image=?,preview_video=?,likes_count=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`,
        asset.type, asset.media_path, asset.media_driver, input.caption, input.sort_order, Number(input.published), Number(showAsPreview), preview, teaser, likesCount, id, input.version);
      if (!result.changes) throw fail('Esta publicação mudou. Recarregue antes de salvar.', 409);
    } else {
      // A retry after a lost response must not publish the same upload twice.
      id = 'post-' + (input.uploadId || (head && head.uploadId));
      await db.run('INSERT INTO vip_posts(id,type,media_path,media_driver,caption,sort_order,published,show_as_preview,preview_image,preview_video,likes_count) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        id, asset.type, asset.media_path, asset.media_driver, input.caption, input.sort_order, Number(input.published), Number(showAsPreview), preview, teaser, likesCount);
    }
    // On create retry, keep the original crop instead of overwriting a later edit.
    if (old || (await db.get('SELECT crop_data FROM vip_posts WHERE id=?',id)).crop_data == null) {
      await db.run('UPDATE vip_posts SET crop_data=? WHERE id=?',JSON.stringify(framing),id);
    }

    /* ------------------------------------------------------------ carrossel */
    const row = await db.get('SELECT * FROM vip_posts WHERE id=?', id);
    if (Array.isArray(input.items)) {
      staleMedia = await postMedia.replaceAll(db, row, input.items, sessionId);
      // O item 1 e as colunas antigas descrevem a mesma mídia: é o que mantém
      // o fallback honesto enquanto os dois modelos convivem.
      const first = (await postMedia.listFor(db, row))[0];
      if (first) {
        await db.run('UPDATE vip_posts SET type=?,media_path=?,media_driver=?,crop_data=?,preview_image=?,preview_video=? WHERE id=?',
          first.type, first.media_path, first.media_driver, first.crop_data, first.preview_image, first.preview_video, id);
      }
    } else {
      // Sem carrossel, a mídia única continua sendo o item 1, espelhada aqui.
      // O que aponta para outro arquivo sai ANTES: o item guarda o mesmo id e
      // só troca de caminho, então tentar inserir por cima bateria na chave.
      const sobrando = await db.all('SELECT media_path,preview_video FROM vip_post_media WHERE post_id=? AND media_path<>?', id, asset.media_path);
      if (sobrando.length) {
        await db.run('DELETE FROM vip_post_media WHERE post_id=? AND media_path<>?', id, asset.media_path);
        // Só a derivada: trocar a mídia não apaga o original antigo, que é o
        // comportamento que já estava no ar antes do carrossel existir.
        staleMedia = sobrando.map(r => r.preview_video).filter(Boolean);
      }
      await db.run(`INSERT INTO vip_post_media(id,post_id,type,media_path,media_driver,sort_order,crop_data,preview_image,preview_video)
        VALUES (?,?,?,?,?,0,?,?,?)
        ON CONFLICT(post_id,media_path) DO UPDATE SET type=excluded.type,media_driver=excluded.media_driver,
          crop_data=excluded.crop_data,preview_image=excluded.preview_image,preview_video=excluded.preview_video,updated_at=CURRENT_TIMESTAMP`,
      'item-' + id, id, asset.type, asset.media_path, asset.media_driver, JSON.stringify(framing), preview, teaser);
    }
    return db.get(`SELECT ${LIST_COLUMNS} FROM vip_posts WHERE id=?`, id);
  });
  // Falhar aqui não desfaz o que foi salvo: o caminho continua na fila e a
  // próxima passagem da limpeza tenta de novo.
  if (staleTeaser) await cleanup.clean(staleTeaser).catch(() => 'pending');
  // Mídias que saíram do carrossel: a limpeza confere referências antes de
  // apagar, então arquivo usado por outro post, avatar ou capa fica onde está.
  if (staleMedia.length) await postMedia.releaseOrphans(transaction, staleMedia);
  return saved;
}
async function archive(id, archived, version) {
  const result = await (await getDb()).run(`UPDATE vip_posts SET archived=?,published=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND creator_id='ayla' AND version=?`, Number(archived), id, version);
  if (!result.changes) throw fail('Publicação não encontrada ou alterada. Recarregue.', 409);
}
/**
 * Traz o feed antigo (`vip-content.js`) para `vip_posts`.
 *
 * Preserva o que existia: ordem, legenda, tipo, caminho da mídia, estado
 * publicado (vaga marcada `draft` entra como rascunho) e a contagem de
 * curtidas, que vira `likes_count`.
 *
 * Idempotente pelo id `legacy-<id>`: rodar de novo não duplica e NÃO sobrescreve
 * o que você já editou no painel. Os blocos de chamada (`type: 'cta'`) ficam de
 * fora — não são publicação.
 *
 * Importante: isto copia REGISTRO, não bytes. Se o Storage ativo for o Supabase
 * e o arquivo estiver só no computador, troque a mídia pelo painel antes de
 * contar com ela em produção.
 */
async function migrate() {
  return transaction(async db => {
    let imported = 0;
    for (const [index, post] of legacy.posts.entries()) {
      if (!['image', 'video'].includes(post.type) || !media.safeObjectPath(post.source)) continue;
      const likes = Number.isFinite(post.likes) && post.likes > 0 ? Math.min(Math.round(post.likes), 100000000) : 0;
      const result = await db.run(`INSERT INTO vip_posts(id,type,media_path,media_driver,caption,sort_order,published,likes_count)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        'legacy-' + post.id, post.type, post.source, media.driverName(), post.caption || '',
        index, post.draft ? 0 : 1, likes);
      imported += result.changes;
    }
    return imported;
  });
}

/**
 * Importa o feed antigo e passa a usar o banco — uma vez só.
 *
 * Roda no boot. Só age quando ainda não existe nenhuma publicação gerenciada:
 * se você já criou ou editou qualquer post pelo painel, esta função não encosta
 * em nada. É a ponte para deixar TODO post editável pelo modo administrador.
 */
async function adoptLegacyOnce() {
  const db = await getDb();
  // Depois que o painel assume o feed, NUNCA reimportar: sem isto, apagar
  // a última publicação fazia o feed antigo voltar no próximo boot.
  if (await source(db) === 'managed') return { imported: 0, switched: false, reason: 'o feed já é gerenciado pelo painel' };
  const existing = await db.get("SELECT COUNT(*) AS n FROM vip_posts WHERE creator_id='ayla'");
  if (Number(existing.n) > 0) return { imported: 0, switched: false, reason: 'já existem publicações no banco' };
  const imported = await migrate();
  if (!imported) return { imported: 0, switched: false, reason: 'o feed antigo não tinha publicação para importar' };
  await setSource('managed');
  return { imported, switched: true, reason: null };
}
async function like(postId, orderId, liked) {
  if (typeof liked !== 'boolean') throw fail('Estado de curtida inválido.');
  return transaction(async db => {
    if (await source(db) !== 'managed') throw fail('Este post usa reações locais.', 409);
    // Lock the post so archive/unpublish cannot race this write.
    const locked = await db.run("UPDATE vip_posts SET id=id WHERE id=? AND published=1 AND archived=0 AND creator_id='ayla'", postId);
    if (!locked.changes) throw fail('Publicação indisponível.', 404);
    if (liked) await db.run('INSERT INTO vip_post_likes(id,post_id,order_id) VALUES (?,?,?) ON CONFLICT(post_id,order_id) DO NOTHING', crypto.randomUUID(), postId, orderId);
    else await db.run('DELETE FROM vip_post_likes WHERE post_id=? AND order_id=?', postId, orderId);
    const post = await db.get('SELECT likes_count FROM vip_posts WHERE id=?', postId);
    return { liked, likes: Number(post.likes_count || 0) + Number((await db.get('SELECT COUNT(*) AS n FROM vip_post_likes WHERE post_id=?', postId)).n) };
  });
}
async function deletePermanent(id, version) {
  let extras = [];
  const result = await transaction(async db => {
    await cleanup.lock(db);
    const post = await db.get("SELECT * FROM vip_posts WHERE id=? AND creator_id='ayla'",id);
    if (!post) throw fail('Publicação não encontrada.',404);
    if (post.version !== version) throw fail('Publicação alterada. Recarregue antes de excluir.',409);
    // Os arquivos de TODOS os itens do carrossel, anotados antes do DELETE.
    const items = await postMedia.listFor(db, post);
    extras = items.flatMap(item => [item.media_path, item.preview_video]).filter(Boolean);
    await db.run('DELETE FROM vip_post_media WHERE post_id=?',id);
    await db.run('DELETE FROM vip_post_likes WHERE post_id=?',id);
    await db.run('DELETE FROM vip_posts WHERE id=?',id);
    const shared = await cleanup.shared(db,post.media_path);
    const removable = !shared && post.media_driver === 'supabase' && post.media_path.startsWith('ayla/');
    if (removable) await db.run('INSERT INTO media_deletions(media_path) VALUES (?) ON CONFLICT(media_path) DO NOTHING RETURNING media_path',post.media_path);
    // O teaser é arquivo próprio e some junto — depois do DELETE, para o
    // `shared` não contar a própria publicação que acabou de ser apagada.
    let teaser = null;
    if (post.preview_video && !await cleanup.shared(db, post.preview_video)) {
      await queueStaleTeaser(db, post.preview_video);
      teaser = post.preview_video;
    }
    return { path:post.media_path, removable, shared, teaser };
  });
  const storage = result.removable ? await cleanup.clean(result.path).catch(()=>'pending') : result.shared ? 'shared' : 'preserved';
  const teaser = result.teaser ? await cleanup.clean(result.teaser).catch(()=>'pending') : 'none';
  // Os demais itens do carrossel passam pela mesma limpeza segura: o que ainda
  // é usado por outro post, pelo avatar ou pela capa continua no Storage.
  const pendentes = extras.filter(p => p !== result.path && p !== result.teaser);
  const items = pendentes.length ? await postMedia.releaseOrphans(transaction, pendentes) : [];
  return { deleted:true, storage, teaser, items };
}
module.exports = { deletePermanent, source, setSource, list, feed, adminFeed, homePreviews, homeTeaserPath, findMediaItem, findPublished, findForAdmin, save, archive, migrate, adoptLegacyOnce, like, fail, MAX_HOME_PREVIEWS };
