/**
 * PRÉVIA DERIVADA DA HOME.
 *
 * A HOME mostra uma amostra BLOQUEADA das publicações. O visitante não é
 * assinante, então ele não pode receber a mídia original — nem por link
 * assinado, nem por Storage público. O que ele recebe é uma DERIVADA:
 * um JPEG minúsculo, gerado a partir do arquivo no próprio painel, no
 * momento do upload, e guardado no banco junto do post.
 *
 * Por que minúsculo resolve: um quadro de 64 px de largura já perdeu
 * irreversivelmente o conteúdo do original. Não existe "desfazer o
 * downscale". O blur visual da HOME é acabamento, não é a proteção — a
 * proteção é o tamanho. Por isso o limite de dimensão é validado AQUI,
 * no servidor, e não no navegador que enviou.
 *
 * O original continua onde sempre esteve: bucket privado, entregue só por
 * link assinado de curta duração a quem tem assinatura ativa.
 */

const MAX_BYTES = 24 * 1024;
const MAX_EDGE = 200;

/**
 * Lê largura/altura direto do cabeçalho SOF do JPEG.
 *
 * Sem biblioteca de imagem: só precisamos confirmar que o que chegou é
 * mesmo um JPEG e que ele é pequeno o bastante. Percorre os marcadores
 * até o Start Of Frame; qualquer estrutura inesperada devolve null e o
 * arquivo é recusado (falha fechada).
 */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  let index = 2;
  while (index + 9 < buffer.length) {
    if (buffer[index] !== 0xFF) return null;
    const marker = buffer[index + 1];
    // Marcadores sem payload (padding, restart, EOI).
    if (marker === 0xFF) { index += 1; continue; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { index += 2; continue; }
    const length = buffer.readUInt16BE(index + 2);
    if (length < 2) return null;
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC).
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      if (index + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(index + 5), width: buffer.readUInt16BE(index + 7) };
    }
    index += 2 + length;
  }
  return null;
}

/**
 * Valida a derivada enviada pelo painel e devolve o base64 normalizado.
 *
 * `null` significa "não mandou derivada" — quem chama decide se isso é um
 * problema (marcar prévia da HOME sem derivada é recusado em vip-posts).
 */
function normalize(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_BYTES * 2) return undefined;
  // Aceita tanto o base64 puro quanto o data URI que o canvas produz.
  const base64 = value.startsWith('data:image/jpeg;base64,') ? value.slice('data:image/jpeg;base64,'.length) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) return undefined;
  const size = jpegSize(bytes);
  if (!size || !size.width || !size.height) return undefined;
  if (size.width > MAX_EDGE || size.height > MAX_EDGE * 2) return undefined;
  return bytes.toString('base64');
}

function dataUri(base64) {
  return base64 ? 'data:image/jpeg;base64,' + base64 : null;
}

module.exports = { normalize, dataUri, jpegSize, MAX_BYTES, MAX_EDGE };
