-- Additive schema shared by SQLite and PostgreSQL. No payment tables changed.
CREATE TABLE IF NOT EXISTS media_deletions (
  media_path TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS creator_profiles (
  id TEXT PRIMARY KEY CHECK (id = 'ayla'),
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  bio TEXT NOT NULL,
  avatar_path TEXT,
  cover_path TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vip_posts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL DEFAULT 'ayla' CHECK (creator_id = 'ayla'),
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  media_path TEXT NOT NULL,
  media_driver TEXT NOT NULL CHECK (media_driver IN ('local','supabase')),
  caption TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  -- HOME preview: opt-in per post. preview_image is a tiny blurred derivative,
  -- never the original media. Added by migration on databases created earlier.
  show_as_preview INTEGER NOT NULL DEFAULT 0,
  preview_image TEXT,
  -- Teaser de vídeo da HOME: o CAMINHO de um arquivo derivado e independente
  -- (ayla/previews/...), com ~5s, sem áudio e com o desfoque já gravado
  -- dentro dele. Nunca aponta para o original em ayla/posts/.
  preview_video TEXT,
  -- Contagem exibida, definida pela criadora. As curtidas reais dos assinantes
  -- ficam em vip_post_likes e são somadas a este número na hora de mostrar.
  likes_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS vip_posts_feed_idx ON vip_posts(creator_id,published,archived,sort_order,created_at);

-- As mídias de uma publicação, em ordem.
--
-- Uma publicação pode ter uma foto só, como sempre teve, ou um carrossel
-- misturando foto e vídeo. O que é do POST continua no post — legenda,
-- curtidas, publicado, arquivado, prévia na HOME. O que é de CADA ARQUIVO
-- mora aqui: o caminho no Storage, o enquadramento e as derivadas seguras.
--
-- preview_image e preview_video pertencem à mídia porque cada vídeo do
-- carrossel tem o seu próprio teaser e cada foto a sua própria amostra.
--
-- As colunas antigas de mídia continuam em vip_posts de propósito: esta fase
-- é aditiva, e o backend ainda sabe ler o modelo antigo se esta tabela
-- estiver vazia para algum post.
CREATE TABLE IF NOT EXISTS vip_post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES vip_posts(id),
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  media_path TEXT NOT NULL,
  media_driver TEXT NOT NULL CHECK (media_driver IN ('local','supabase')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  crop_data TEXT,
  preview_image TEXT,
  preview_video TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS vip_post_media_order_idx ON vip_post_media(post_id,sort_order,created_at,id);
-- Uma publicação não aponta duas vezes para o mesmo arquivo: a migração pode
-- rodar de novo à vontade e o painel não duplica item por engano.
CREATE UNIQUE INDEX IF NOT EXISTS vip_post_media_unique_idx ON vip_post_media(post_id,media_path);
-- vip_posts_preview_idx is created by initDb, after the additive columns exist.
CREATE TABLE IF NOT EXISTS vip_content_settings (
  id TEXT PRIMARY KEY CHECK (id = 'ayla'),
  source TEXT NOT NULL DEFAULT 'legacy' CHECK (source IN ('legacy','managed'))
);
CREATE TABLE IF NOT EXISTS vip_post_likes (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES vip_posts(id),
  order_id BIGINT NOT NULL REFERENCES orders(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id,order_id)
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  secret_version TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_login_limits (
  id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  resets_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS vip_uploads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  media_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  received_bytes BIGINT NOT NULL DEFAULT 0,
  remote_bytes BIGINT NOT NULL DEFAULT 0,
  pending_chunk TEXT NOT NULL DEFAULT '',
  remote_url TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Quem pode administrar. O `user_id` é o `auth.uid` do Supabase Auth; a conta
-- é criada à mão no painel do Supabase e a linha aqui é o que concede a role.
-- Não existe cadastro público: nada no projeto insere nesta tabela sozinho.
CREATE TABLE IF NOT EXISTS admin_users (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversion_events (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL,
 event TEXT NOT NULL CHECK(event IN ('checkout_opened','whatsapp_clicked')),
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS conversion_events_date ON conversion_events(created_at);
