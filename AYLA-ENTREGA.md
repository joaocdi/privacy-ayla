# Entrega — Ayla

## 1. Origem preservada
`E:\Privacy_Joice` permaneceu somente leitura. Comparação final com o inventário anterior: 5.337 arquivos, zero inclusões/remoções/alterações de tamanho ou data, 171 hashes SHA-256 conferidos e iguais. Nenhuma chamada externa foi feita para modificar Vercel, Supabase, pagamentos ou mídias da origem. Evidência privada: `.audit/source-integrity.json`.

## 2. Destino
`E:\Privacy_Ayla`, pasta irmã, cópia física independente. Git, vínculo Vercel, credenciais, bancos locais, artefatos antigos e fotografias herdadas foram removidos SOMENTE da cópia. Dependências locais foram preservadas para executar os testes. Novo `.env` local usa mock e segredos aleatórios novos; nenhuma chave de serviços externos foi copiada.

## 3. Principais arquivos
- `index.html`, `app.js`, `vip.html/js`, `buyer-account.html/js`, `login.html`: identidade, catálogo e fluxo preservado.
- `frame.js`, `carousel.js`, `image-tools.js`, `pending-checkouts.js`, `admin-loader.js`, `admin-mode.js`: namespaces Ayla, com comportamento original.
- `backend/products.js`, `creator.js`, `services/orders.js`, `entitlements.js`, `buyer-accounts.js`: IDs e fronteira de acesso Ayla.
- `backend/db/postgres.js`, `db/schema.content.sql`, `db/content-migrations.js`: schema exclusivo e creator Ayla.
- `backend/services/profile.js`, `vip-posts.js`, `post-media.js`, `vip-media.js`, `admin-uploads.js`, `media-cleanup.js`, `preview-video.js`: conteúdo e caminhos da Ayla.
- `backend/vip-content.js`: perfil neutro e rascunhos identificados, sem conteúdo original.
- `backend/.env.example`, `.gitignore`, `.vercelignore`, `vercel.json`, `publicar.bat`, `backend/scripts/deploy-preview.js`: configuração independente e Preview apenas.
- `avatar.jpg`, `cover.jpg`, `previews/post-01.jpg` a `post-07.jpg`: placeholders neutros identificados. Selo genérico renomeado `verified-ayla.png`.
- Testes existentes adaptados; novos `ayla-isolation.js` e `ayla-postgres-schema.js`.

## 4–5. Referências e auditoria
Substituídos nome, slug, cookies ADMIN/BUYER, chaves do navegador, globais JS, IDs do perfil, prefixos privados, nomes de bucket, metadados e exemplos técnicos. Telegram: https://t.me/aylabl0nde_bot. Não há telefone herdado. Relatórios antigos com resultados/deployment IDs de outra implantação foram retirados ou substituídos por orientação atual.

A busca final não encontrou referências Joice no código, configuração ou conteúdo de execução. O nome da origem permanece somente neste relatório e em `.audit/` (inventário, cópia e registros de substituição), como prova de integridade; esses arquivos não são servidos publicamente. Nomes genéricos Privacy no projeto/template não são identificadores de acesso entre creators.

## 6. Produtos — preço exclusivamente do backend
| ID | Preço | Duração/escopo | Apresentação |
|---|---|---|---|
| `ayla_monthly` | R$ 9,90 | VIP 30 dias | 1 mês, sem selo |
| `ayla_quarterly` | R$ 19,90 | VIP 90 dias | 3 meses, 33% OFF |
| `ayla_semester` | R$ 29,90 | VIP 180 dias | 6 meses, 50% OFF |
| `ayla_whatsapp_unlock` | R$ 7,90 | contato permanente, sem VIP | indisponível até configurar número Ayla |
Os dias preservam o contrato atual. Nenhum valor enviado pelo navegador controla a cobrança.

## 7. Orders, entitlements e sessões
O schema próprio mantém as mesmas tabelas e migrações. IDs de produto carregam o prefixo `ayla_`; criação de order, confirmação, claim e autorização recusam produto de outra criadora. Entitlement continua único por order e é liberado somente conforme escopo. Contato não libera VIP; assinatura expira conforme 30/90/180 dias.

Fluxo preservado: produto → PIX sem dados pessoais → webhook verificado → PAID → cadastro email/celular/senha/confirmação → BUYER e entitlement → login automático → Meu acesso/VIP. Comprador autenticado recebe novo acesso na mesma conta. Cookie HttpOnly e chaves de navegador usam Ayla. ADMIN permanece separado. Recuperação por email via Supabase; OTP continua preparado e indisponível, sem SMS simulado.

## 8. Storage e banco
Supabase independente para Ayla, bucket PRIVADO `vip-ayla`; objetos `ayla/posts/`, `ayla/profile/`, `ayla/previews/`. Upload de avatar/capa também pode usar o caminho gerado `ayla/posts/` pelo uploader existente, registrado no perfil. Nenhum caminho externo a `ayla/` é autorizado pelo driver remoto. Originals privados por URLs assinadas e entitlement; HOME recebe derivadas. Local privado: `Media_Ayla/`, nunca estático.

PostgreSQL Production: `DATABASE_SCHEMA=ayla`. Preview: `STAGING_DATABASE_SCHEMA=staging_ayla_preview`. Cada conexão/transaction usa search_path isolado, sem fallback para public. Schemas precisam existir antes da primeira inicialização. RLS e estrutura original preservadas. Nenhuma infraestrutura externa foi criada.

## 9. ENV
Modelo completo: `backend/.env.example`; nunca colocar segredos no frontend ou chat.

- Compartilháveis como valores não secretos: endpoints oficiais dos gateways, limites de upload, TTL de mídia, preços aprovados e `BUYER_ACCOUNT_FLOW=true`.
- Próprios Ayla: `CREATOR_SLUG=ayla`, `DATABASE_SCHEMA=ayla`, `STAGING_DATABASE_SCHEMA=staging_ayla_preview`, `VIP_MEDIA_BUCKET=vip-ayla`, `VIP_MEDIA_DIRS=Media_Ayla`, origens `PUBLIC_APP_URL`, `FRONTEND_URL`, `ADMIN_ORIGIN`.
- Criar/configurar no ambiente externo: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VIP_MEDIA_SECRET`, `ADMIN_SESSION_SECRET`, `CRON_SECRET`; `ADMIN_ACCESS_SECRET` somente se desejar o fallback administrativo existente.
- Pagamentos reais, somente em etapa futura: `SYNCPAY_CLIENT_ID`, `SYNCPAY_CLIENT_SECRET`, `SYNCPAY_WEBHOOK_SECRET`, guardar `SYNCPAY_WEBHOOK_ID`; ou chaves SigiloPay. A conta comercial do gateway pode ser a mesma mediante configuração consciente, mas webhook/segredo/URL da aplicação precisam ser próprios. Nada herdado silenciosamente.
- WhatsApp: `WHATSAPP_NUMBER` ainda vazio. Telegram username `aylabl0nde_bot`; `TELEGRAM_BOT_TOKEN` e `TELEGRAM_VIP_CHAT_ID` vazios, `ENABLE_TELEGRAM_BOT=false` até configurar.
- Local: `PAYMENT_PROVIDER=mock`, porta 3334, SQLite novo. Preview seguro: `PAYMENT_PROVIDER=staging`, `APP_ENV=staging`; produção real não publicada.

## 10. Onde colocar as mídias
Pastas de organização, excluídas do deploy: `midias-ayla/avatar/`, `capa/`, `posts/`, `videos/`, `carrossel/`, `vip/`.

Depois de configurar Supabase/admin, envie pelo painel `/criadora/login`: Perfil para avatar/capa; publicações para fotos/vídeos/carrosséis e opção de prévia. O uploader existente gera caminhos privados e derivadas. Copiar um arquivo na pasta de organização não publica automaticamente. Para desenvolvimento legado, use `Media_Ayla/` e cadastre o caminho no adaptador de conteúdo; não coloque originals em `previews/`.

## 11. Validação
- Suíte existente `node tests/run.js`: passou, incluindo SyncPay/SigiloPay simulados, cache de token, preços, idempotência, recuperação de falhas, BUYER, entitlements, ADMIN, uploads, crop/delete, vídeos, carrossel e adaptador PostgreSQL/PGlite.
- Auditoria de segurança: 496/496 verificações passaram.
- Syntax check: passou.
- Testes novos: rejeição de produto/order/storage/schema estrangeiros; schemas Ayla Production/Preview reais em PostgreSQL em memória, preservando public.
- Navegador Chrome: 320, 375, 390, 430, 1280 px — cadastro pós-pagamento, login automático, Meu acesso, VIP, logout/login e recuperação; sem overflow.
- HOME: identidade, planos/selos, Telegram e layout nas cinco larguras.
- Carrossel/touch/vídeo: 12 cenários nas quatro larguras móveis, todos passaram.
- Auth, gateways e Storage externos foram simulados. Nenhuma cobrança, conta real ou envio real de email/SMS. Logs/screen de QA em `backend/.test-runs/`, excluídos de publicação.

## 12. Pendências externas
Mídias finais e texto definitivo da Ayla; Supabase independente (schemas, bucket privado, Auth, redirects, usuário ADMIN); novo projeto Vercel e variáveis Preview; número WhatsApp se vender contato; credenciais/bot se usar Telegram; posteriormente credenciais e webhook próprio para pagamento real. Não é necessário alterar a arquitetura.

## 13. Preview
Código e configuração preparados para Preview independente, condicionado às configurações externas acima. Nenhum deploy foi executado; ainda não existe URL Ayla publicada por esta tarefa. Instruções em `DEPLOY.md`; `publicar.bat` verifica projeto `privacy-ayla` e publica somente Preview. Production somente após solicitação explícita.
