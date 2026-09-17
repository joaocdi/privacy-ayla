/**
 * AS MÍDIAS DE UMA PUBLICAÇÃO.
 *
 * Uma publicação pode ter uma foto só — como sempre teve — ou um carrossel
 * misturando foto e vídeo. O que é do POST continua no post: legenda, curtidas,
 * publicado, arquivado, prévia na HOME. O que é de CADA ARQUIVO mora em
 * `vip_post_media`: caminho no Storage, enquadramento e as derivadas seguras.
 *
 * Por que a amostra e o teaser são da MÍDIA e não do post: num carrossel com
 * dois vídeos, cada um precisa do seu próprio teaser de 5s, e cada foto da sua
 * própria amostra minúscula. Um campo por post não daria conta.
 *
 * COMPATIBILIDADE
 *
 * As colunas antigas de `vip_posts` continuam preenchidas nesta fase. `listFor`
 * lê a tabela nova e, se um post ainda não tiver item nenhum, monta o item 1 a
 * partir das colunas antigas. Nada quebra enquanto as duas formas coexistem.
 *
 * Sobre `crop_data`: é uma coluna JSON, igual à de `vip_posts`, em vez de quatro
 * colunas soltas. O motivo é técnico e não estético — `crop.normalize()` e
 * `crop.read()` já validam e leem exatamente esse formato, então o carrossel
 * reusa a mesma trava de validação em vez de abrir uma segunda.
 */
const crypto = require('crypto');
const crop = require('./crop');
const previewImage = require('./preview-image');
const previewVideo = require('./preview-video');
const media = require('./vip-media');
const cleanup = require('./media-cleanup');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const MAX_ITEMS = 10;
const COLUMNS = 'id,post_id,type,media_path,media_driver,sort_order,crop_data,preview_image,preview_video';

/** A forma que o resto do sistema enxerga. O caminho do arquivo fica de fora. */
function present(row, index) {
  return {
    id: row.id,
    type: row.type,
    position: index,
    crop: crop.read(row.crop_data),
    hasPreview: Boolean(row.preview_image),
    hasTeaser: previewVideo.isPreviewPath(row.preview_video)
  };
}

/**
 * As mídias de um post, em ordem.
 *
 * Devolve as linhas cruas (com `media_path`) porque quem chama precisa montar
 * link assinado ou conferir existência. Quem responde ao navegador usa
 * `present()` por cima disso.
 */
async function listFor(db, post) {
  const rows = await db.all(`SELECT ${COLUMNS} FROM vip_post_media WHERE post_id=? ORDER BY sort_order,created_at,id`, post.id);
  if (rows.length) return rows;
  // Fallback do modelo antigo: post que ainda não passou pela migração.
  if (!post.media_path) return [];
  return [{
    id: 'item-' + post.id, post_id: post.id, type: post.type,
    media_path: post.media_path, media_driver: post.media_driver, sort_order: 0,
    crop_data: post.crop_data, preview_image: post.preview_image, preview_video: post.preview_video
  }];
}

/**
 * As mídias de vários posts de uma vez, para o feed não fazer N consultas.
 *
 * `fallback: false` desliga a reconstrução a partir das colunas antigas. Quem
 * responde ao VISITANTE usa assim: aquele código não pode nem ler `media_path`,
 * e post sem item simplesmente não abre carrossel — a prévia do post continua.
 */
async function listForMany(db, posts, { fallback = true } = {}) {
  if (!posts.length) return new Map();
  const marks = posts.map(() => '?').join(',');
  const rows = await db.all(`SELECT ${COLUMNS} FROM vip_post_media WHERE post_id IN (${marks}) ORDER BY sort_order,created_at,id`,
    ...posts.map(p => p.id));
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.post_id)) grouped.set(row.post_id, []);
    grouped.get(row.post_id).push(row);
  }
  for (const post of posts) {
    if (!grouped.has(post.id)) grouped.set(post.id, fallback ? await listFor(db, post) : []);
  }
  return grouped;
}

/**
 * Valida o que o painel mandou para UM item.
 *
 * `uploadId` traz arquivo novo; sem ele, o item precisa já existir e só muda de
 * enquadramento, posição ou derivada. Tudo passa pelas mesmas travas de sempre:
 * o enquadramento por `crop.normalize`, a amostra por `preview-image` e o
 * teaser por `preview-video`.
 */
function validateItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('Mídia inválida no carrossel.');
  if (item.id !== undefined && (typeof item.id !== 'string' || item.id.length > 80)) throw fail('Identificador de mídia inválido.');
  if (item.uploadId !== undefined && typeof item.uploadId !== 'string') throw fail('Envio de mídia inválido.');
  if (item.previewUploadId !== undefined && item.previewUploadId !== null && typeof item.previewUploadId !== 'string') throw fail('Envio de teaser inválido.');
  if (item.preview_image !== undefined && previewImage.normalize(item.preview_image) === undefined) {
    throw fail(`Amostra da HOME inválida na mídia ${index + 1}. Escolha o arquivo de novo.`);
  }
  crop.normalize(item.crop === undefined ? null : item.crop);
}

/**
 * Grava a lista inteira de mídias de um post.
 *
 * Recebe a lista final na ordem em que a criadora deixou. O que sumiu da lista
 * é apagado da tabela e o arquivo entra na limpeza segura — que ainda confere
 * se alguém mais aponta para ele antes de remover do Storage.
 *
 * Devolve os caminhos que ficaram órfãos, para quem chamou limpar DEPOIS de a
 * transação fechar (chamada de rede não pode segurar o banco).
 */
async function replaceAll(db, post, items, sessionId) {
  if (!Array.isArray(items)) throw fail('Lista de mídias inválida.');
  if (!items.length) throw fail('A publicação precisa de pelo menos uma mídia.');
  if (items.length > MAX_ITEMS) throw fail(`No máximo ${MAX_ITEMS} mídias por publicação.`);
  items.forEach(validateItem);

  const before = await listFor(db, post);
  const byId = new Map(before.map(row => [row.id, row]));
  const kept = [];

  for (const [index, item] of items.entries()) {
    const old = item.id ? byId.get(item.id) : null;
    if (item.id && !old) throw fail('Mídia não encontrada nesta publicação. Recarregue antes de salvar.', 409);

    let asset = old && { media_path: old.media_path, type: old.type, media_driver: old.media_driver };
    if (item.uploadId) {
      const upload = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND complete=1', item.uploadId, sessionId);
      if (!upload) throw fail('Upload não concluído ou não pertence a esta sessão.');
      asset = { media_path: upload.media_path, type: upload.type, media_driver: 'supabase' };
    }
    if (!asset) throw fail(`Selecione o arquivo da mídia ${index + 1}.`);
    await cleanup.usable(db, asset.media_path);

    // Arquivo novo invalida as derivadas antigas: elas mostravam outro arquivo.
    const trocou = Boolean(item.uploadId) && old && old.media_path !== asset.media_path;
    const sentPreview = item.preview_image === undefined ? null : previewImage.normalize(item.preview_image);
    const preview = sentPreview !== null ? sentPreview : trocou || !old ? null : old.preview_image;

    let teaser = trocou || !old ? null : old.preview_video;
    if (item.previewUploadId !== undefined) {
      if (item.previewUploadId === null) teaser = null;
      else {
        const sent = await db.get('SELECT * FROM vip_uploads WHERE id=? AND session_id=? AND complete=1', item.previewUploadId, sessionId);
        if (!sent) throw fail('Teaser não concluído ou não pertence a esta sessão.');
        teaser = previewVideo.validateUpload(sent, { fail });
      }
    }
    if (asset.type !== 'video') teaser = null;

    const framing = JSON.stringify(item.crop === undefined ? crop.read(old?.crop_data) : crop.normalize(item.crop));
    const id = old ? old.id : 'item-' + crypto.randomUUID();

    if (old) {
      await db.run(`UPDATE vip_post_media SET type=?,media_path=?,media_driver=?,sort_order=?,crop_data=?,preview_image=?,preview_video=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        asset.type, asset.media_path, asset.media_driver, index, framing, preview, teaser, id);
    } else {
      await db.run(`INSERT INTO vip_post_media(id,post_id,type,media_path,media_driver,sort_order,crop_data,preview_image,preview_video)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(post_id,media_path) DO UPDATE SET sort_order=excluded.sort_order,crop_data=excluded.crop_data,updated_at=CURRENT_TIMESTAMP`,
      id, post.id, asset.type, asset.media_path, asset.media_driver, index, framing, preview, teaser);
    }
    const saved = await db.get('SELECT id FROM vip_post_media WHERE post_id=? AND media_path=?', post.id, asset.media_path);
    kept.push({ id: saved.id, media_path: asset.media_path, oldPath: old?.media_path, oldTeaser: old?.preview_video, teaser });
  }

  // O que saiu da lista some da tabela; o arquivo vai para a limpeza segura.
  const keptIds = new Set(kept.map(k => k.id));
  const orphans = [];
  for (const row of before) {
    if (keptIds.has(row.id)) continue;
    await db.run('DELETE FROM vip_post_media WHERE id=?', row.id);
    orphans.push(row.media_path, row.preview_video);
  }
  // TROCAR a mídia de um item é diferente de REMOVER o item: o arquivo
  // substituído continua no Storage, como sempre foi, para uma troca sem
  // querer não custar o original. Só a derivada antiga, que passou a mostrar
  // outro arquivo e não serve mais para nada, sai junto.
  for (const item of kept) {
    if (item.oldTeaser && item.oldTeaser !== item.teaser) orphans.push(item.oldTeaser);
  }
  return orphans.filter(Boolean);
}

/**
 * Enfileira e apaga os arquivos que ficaram sem dono.
 *
 * `cleanup.shared` continua sendo quem decide: arquivo usado por outro post,
 * por outra mídia, pelo avatar, pela capa ou pelo feed antigo NÃO é apagado.
 * Rodar isto fora da transação é de propósito.
 */
async function releaseOrphans(transaction, paths) {
  const results = [];
  for (const path of [...new Set(paths)]) {
    if (!path || !path.startsWith('ayla/') || media.driverName() !== 'supabase') continue;
    const stillUsed = await transaction(async db => {
      if (await cleanup.shared(db, path)) return true;
      await db.run('INSERT INTO media_deletions(media_path) VALUES (?) ON CONFLICT(media_path) DO NOTHING RETURNING media_path', path);
      return false;
    });
    if (stillUsed) { results.push({ path, storage: 'shared' }); continue; }
    results.push({ path, storage: await cleanup.clean(path).catch(() => 'pending') });
  }
  return results;
}

module.exports = { listFor, listForMany, replaceAll, releaseOrphans, present, MAX_ITEMS, COLUMNS };
