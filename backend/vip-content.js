// Independent Ayla profile. Replace placeholders through the existing ADMIN.
const profile = {
  name: 'Ayla', username: '@ayla', verified: true,
  avatar: '/avatar.jpg', cover: '/cover.jpg',
  bio: 'Perfil da Ayla em preparação. As mídias oficiais serão publicadas aqui.',
  stats: { posts: 0, photos: 0, videos: 0, likes: '0' }
};
// Feed legado VAZIO de propósito: a Ayla publica pelo painel da criadora.
// Vaga de placeholder aqui viraria post no banco e card quebrado no site.
const posts = [];
module.exports = { profile, posts };
