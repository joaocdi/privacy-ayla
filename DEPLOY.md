# Configuração automática (recomendado)

Na pasta `E:\Privacy_Ayla`, dê dois cliques em **`configurar_ayla.bat`**. O script pede as credenciais no próprio terminal (nada aparece na tela, nada é salvo em arquivo) e faz, nesta ordem:

1. confere se URL e chaves são do projeto Supabase da Ayla (`xztyqmiluvqsjzwofcem`);
2. testa Auth e Storage do mesmo jeito que o backend usa;
3. monta a `DATABASE_URL` do **Transaction Pooler :6543** com a senha codificada;
4. cria `ayla` e `staging_ayla_preview`, aplica as migrations e fecha os schemas para `anon`/`authenticated`;
5. garante o bucket **privado** `vip-ayla`;
6. (opcional) cria o primeiro ADMIN no Supabase Auth e libera em `admin_users` nos dois schemas;
7. cria/liga o projeto Vercel `privacy-ayla` e grava as variáveis de Preview e Production;
8. (opcional) publica um **Preview** — nunca Production.

Chaves: use a aba **"Legacy anon, service_role API keys"** (começam com `eyJ`). As novas `sb_publishable_`/`sb_secret_` não funcionam nas chamadas diretas de Storage que o backend faz; o script testa e avisa. Resumo sem segredos: `.audit/configuracao-ayla.json`. Pode rodar de novo: tudo é idempotente e os segredos gerados são mantidos.

Production continua bloqueada até existir gateway real: sem `PAYMENT_PROVIDER` de produção o servidor não sobe (de propósito).

---

# Preview independente da Ayla

1. Crie um projeto Supabase separado para Ayla, usando a mesma arquitetura Auth/PostgreSQL/Storage. Não reutilize credenciais ou usuários de outra criadora.
2. No banco novo, crie schemas `ayla` e `staging_ayla_preview` para o usuário do backend. O código cria suas tabelas e aplica as mesmas migrações/RLS no schema selecionado, sem fallback para public. Não exponha esses schemas na Data API. O backend precisa das permissões de criação/migração. As roles públicas anon/authenticated não devem receber permissões nesses schemas.
3. Crie o bucket PRIVADO `vip-ayla`. Objetos usam `ayla/posts/`, `ayla/profile/`, `ayla/previews/`. Preferencialmente use projeto/bucket separado também para o Preview; se compartilhar o bucket Ayla, a limpeza verifica referências no schema `ayla` antes de apagar.
4. Na pasta Ayla execute `vercel link --project privacy-ayla` para um NOVO projeto. A cópia não contém `.vercel`, Git nem vínculo herdado. Confira o nome e ID do novo projeto no painel.
5. Configure variáveis apenas no ambiente Preview: `NODE_ENV=production`, `APP_ENV=staging`, `PAYMENT_PROVIDER=staging`, `STAGING_DATABASE_SCHEMA=staging_ayla_preview`, `DATABASE_SCHEMA=ayla`, `BUYER_ACCOUNT_FLOW=true`, banco/Auth/Storage Ayla e segredos novos conforme `backend/.env.example`. Defina `VIP_MEDIA_DRIVER=supabase` e `VIP_MEDIA_BUCKET=vip-ayla`. Não use SyncPay real em Preview.
6. Configure Site URL/redirects do Auth para o domínio Ayla e `/redefinir-senha` do Preview. Crie o administrador no Auth novo e sua linha `admin_users` com role `admin` no schema Preview. BUYER é criado pelo fluxo pós-pagamento.
7. Execute `publicar.bat` ou `node backend/scripts/deploy-preview.js`. O comando exige vínculo com `privacy-ayla` e executa somente `vercel deploy`, sem `--prod`. A publicação NÃO foi executada nesta tarefa.
8. Revise HOME `/`, comprador `/login`, `/meu-acesso`, recuperação `/esqueci-senha`, redefinição `/redefinir-senha`, VIP `/vip`, admin `/criadora/login`. Preview permite simular pagamento; não gera cobrança real.

Publicação Production exige solicitação separada. Depois disso, configure `APP_ENV=production`, `DATABASE_SCHEMA=ayla`, `PAYMENT_PROVIDER=syncpay`, domínio definitivo, credenciais e webhook exclusivos. Preserve SigiloPay como opção. Nunca copie webhook ID/segredo de outra implantação.

O build público contém apenas fontes e selo; HTML/JS permitidos e APIs passam pelo servidor. Backend, envs, scripts, testes, auditoria e mídias privadas não são estáticos.
