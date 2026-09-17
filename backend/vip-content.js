// Independent Ayla profile. Replace placeholders through the existing ADMIN.
const profile = {
  name: 'Ayla', username: '@ayla', verified: true,
  avatar: '/avatar.jpg', cover: '/cover.jpg',
  bio: 'Perfil da Ayla em preparação. As mídias oficiais serão publicadas aqui.',
  // Base histórica do perfil: o que já existia antes deste site. É SOMADA ao
  // conteúdo real publicado pelo painel (nada fica fixo no frontend). Mexer
  // aqui é o único lugar para ajustar os números exibidos.
  stats: { posts: 138, photos: 69, videos: 124, likes: '23100' }
};
// Feed legado VAZIO de propósito: a Ayla publica pelo painel da criadora.
// Vaga de placeholder aqui viraria post no banco e card quebrado no site.
const posts = [];
module.exports = { profile, posts };
