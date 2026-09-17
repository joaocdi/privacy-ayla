/**
 * TEASER DE VÍDEO DA HOME.
 *
 * Irmão do `preview-image.js`, e pela mesma razão: o visitante não é
 * assinante, então ele não pode receber o arquivo original — nem por link
 * assinado, nem por Storage público, nem "borrado por CSS", que é só uma
 * folha de estilo que qualquer um desliga.
 *
 * O que ele recebe é um arquivo DIFERENTE: poucos segundos, resolução
 * pequena, SEM faixa de áudio e com o desfoque gravado dentro do próprio
 * vídeo. Assim como no JPEG minúsculo da prévia de imagem, a proteção é a
 * degradação irreversível, não o enfeite na tela.
 *
 * Onde cada coisa mora:
 *   original   ayla/posts/<uuid>.mp4       privado, só com assinatura ativa
 *   teaser     ayla/previews/<uuid>.webm   derivado, público pela rota da HOME
 *
 * QUEM DERIVA
 *
 * O painel, no navegador da criadora (canvas + MediaRecorder), do mesmo jeito
 * que a amostra JPEG já era feita. É o único lugar que sempre tem o arquivo em
 * mãos: em produção o backend roda serverless e não tem ffmpeg instalado.
 *
 * Quando o ffprobe EXISTE na máquina (desenvolvimento, ou um servidor com o
 * binário), ele é usado aqui para conferir de verdade a duração, a altura e a
 * ausência de áudio do que chegou. Quando não existe, valem as travas
 * estruturais abaixo — e o arquivo continua sendo uma derivada pequena feita
 * a partir de um canvas desfocado, nunca o original.
 *
 * Em nenhum dos dois caminhos existe fallback que entregue o original.
 */
const { execFileSync } = require('child_process');

/** Alvo do teaser. Curto de propósito: é chamariz, não amostra grátis. */
const SECONDS = 7;
/** Folga para o MediaRecorder fechar o último quadro. */
const MAX_SECONDS = 8.5;
/** 240p. Acima disso deixa de ser derivada e começa a ser o conteúdo. */
const MAX_HEIGHT = 380;
/** ~7s de 240p desfocado cabe folgado aqui; o limite corta arquivo suspeito. */
const MAX_BYTES = 3 * 1024 * 1024;
const MIME = { 'video/webm': 'webm', 'video/mp4': 'mp4' };

/** O caminho é de teaser? Só este prefixo sai pela rota pública da HOME. */
const PREFIX = 'ayla/previews/';
function isPreviewPath(value) {
  return typeof value === 'string'
    && value.startsWith(PREFIX)
    && /^ayla\/previews\/[A-Za-z0-9_-]{1,80}\.(webm|mp4)$/.test(value);
}

/** O container é mesmo o que diz ser? Mesma checagem do upload, repetida aqui. */
function sniff(bytes, mime) {
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime === 'video/mp4') return bytes.toString('ascii', 4, 8) === 'ftyp';
  return false;
}

/**
 * ffprobe, quando a máquina tiver.
 *
 * Devolve `null` se o binário não existir — quem chama trata isso como
 * "não deu para conferir a fundo", nunca como "está aprovado".
 */
function probe(file) {
  let binary = 'ffprobe';
  try { binary = require('@ffmpeg-installer/ffmpeg').path.replace(/ffmpeg$/, 'ffprobe'); } catch (_) { /* usa o do PATH */ }
  const run = command => execFileSync(command, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,height',
    '-of', 'json', file
  ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString();
  let raw;
  try { raw = run(binary); }
  catch (_) { try { raw = run('ffprobe'); } catch (_) { return null; } }
  try {
    const data = JSON.parse(raw);
    const streams = data.streams || [];
    return {
      duration: Number(data.format?.duration) || 0,
      height: Math.max(0, ...streams.filter(s => s.codec_type === 'video').map(s => Number(s.height) || 0)),
      hasAudio: streams.some(s => s.codec_type === 'audio')
    };
  } catch (_) { return null; }
}

/**
 * O teaser que o painel enviou pode virar prévia da HOME?
 *
 * Recebe o registro do upload já concluído. Não baixa o arquivo do Storage:
 * confere o que o servidor já sabe (mime, tamanho, caminho) e, quando há um
 * arquivo local para inspecionar, também duração, altura e áudio.
 *
 * Falha fechada: qualquer coisa fora do esperado vira erro, e o post
 * simplesmente fica sem teaser — a HOME cai no pôster desfocado que já existe.
 */
function validateUpload(upload, { fail }) {
  if (!upload || upload.type !== 'video' || !MIME[upload.mime_type]) {
    throw fail('O teaser da HOME precisa ser um vídeo MP4 ou WebM.');
  }
  if (!isPreviewPath(upload.media_path)) {
    throw fail('O teaser precisa ser enviado como prévia, em caminho próprio.');
  }
  if (!Number.isInteger(Number(upload.size_bytes)) || Number(upload.size_bytes) > MAX_BYTES) {
    throw fail('Teaser grande demais. Ele deve ter poucos segundos em baixa resolução.');
  }
  return upload.media_path;
}

/**
 * Conferência profunda de um arquivo em disco, quando existe ffprobe.
 * Usada pelo driver local e pelos testes. Devolve `{ ok, reason }`.
 */
function inspect(file) {
  const data = probe(file);
  if (!data) return { ok: true, reason: 'ffprobe indisponível: valeram as travas de formato e tamanho' };
  if (data.hasAudio) return { ok: false, reason: 'o teaser não pode ter faixa de áudio' };
  if (data.duration > MAX_SECONDS) return { ok: false, reason: `o teaser passa de ${MAX_SECONDS}s` };
  if (data.height > MAX_HEIGHT) return { ok: false, reason: `o teaser passa de ${MAX_HEIGHT}p de altura` };
  return { ok: true, reason: null, ...data };
}

module.exports = { validateUpload, inspect, probe, sniff, isPreviewPath, PREFIX, SECONDS, MAX_SECONDS, MAX_HEIGHT, MAX_BYTES, MIME };
