const ratios = { post: ['original','4:5','1:1'], avatar: ['1:1'], cover: ['2.44:1'] };
function normalize(value, role = 'post') {
  const fallback = { x: 50, y: 50, zoom: 1, ratio: ratios[role][0] };
  if (value == null) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result = { ...fallback, ...value };
  if (!ratios[role].includes(result.ratio) || !Number.isFinite(result.x) || result.x < 0 || result.x > 100 ||
    !Number.isFinite(result.y) || result.y < 0 || result.y > 100 || !Number.isFinite(result.zoom) || result.zoom < 1 || result.zoom > 4) throw invalid();
  return { x: result.x, y: result.y, zoom: result.zoom, ratio: result.ratio };
}
function invalid() { return Object.assign(new Error('Enquadramento inválido: posição 0–100, zoom 1–4 e proporção suportada.'), { status: 400 }); }
function read(value, role = 'post') { return normalize(value ? JSON.parse(value) : null, role); }
module.exports = { normalize, read };
