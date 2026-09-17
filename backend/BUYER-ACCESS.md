# Auditoria de pagamento e acesso do comprador

Antes desta etapa, o frontend mostrava nome completo, e-mail, telefone e CPF/CNPJ quando `requiresClient=true`. Em mock, gerava a cobrança sem formulário. O backend exigia productId e checkoutToken, além dos quatro campos quando o provider exigia cliente.

SigiloPayProvider valida e envia `client.name`, `client.email`, `client.phone`, `client.document`, junto com identifier, amount e callbackUrl para POST /gateway/pix/receive. Usa x-public-key/x-secret-key exclusivamente no backend. Segundo os trechos oficiais fornecidos pelo proprietário nesta conversa, os quatro campos são obrigatórios. A documentação pública não pôde ser revalidada nesta etapa; não houve chamada autenticada nem cobrança real. Portanto CPF/CNPJ não foi removido do contrato. PIX em geral não implica essa exigência: trata-se do contrato SigiloPay fornecido. Para usar somente celular em produção será necessário aceitar os campos adicionais ou avaliar outro provider posteriormente.

Fluxo encontrado: token aleatório de checkout → order CREATING/PENDING com preço do catálogo → provider → transactionId e hash de webhookToken persistidos → webhook autenticado TRANSACTION_PAID → confirmação transacional de PAID + entitlement idempotente → API VIP verifica token, pagamento e validade do entitlement. Polling apenas consulta estado. Antes desta etapa a UI mostrava confirmação só pelo status PAID; agora aguarda também granted=true, calculado no servidor.

O documento completo já não era persistido: ficam hash e três últimos dígitos. Nenhum dado do cliente é logado na criação de PIX. O mock desta etapa coleta apenas celular brasileiro e o salva normalizado com 55 + DDD + número; não envia nome/e-mail/documento fictícios. A integração SigiloPay foi preservada.

A credencial já usada pelo VIP continua em ayla.vip.access no navegador. O checkout salva a cobrança pendente para retomar após refresh; quando PAID + entitlement ACTIVE, persiste o acesso automaticamente. LocalStorage não é fonte de autorização: cada API revalida o banco. Limpar os dados do navegador ou trocar de aparelho exige recuperação.

Recuperação usa buyer_recovery, buyer_recovery_limits e buyer_sessions na mesma camada de banco. Código criptograficamente aleatório, hash HMAC com segredo de backend, validade de cinco minutos, cinco tentativas, uso único e limites persistentes por telefone/IP. Depois da prova de posse do celular, busca exclusivamente pedido PAID e entitlement ACTIVE não expirado. Emite token próprio com hash no banco; não cria pedido nem entitlement. Sessão expira em até 180 dias e o entitlement continua sendo validado em cada acesso.

O adapter otp-provider está indisponível: request/verify retornam 503 em todos os ambientes, sem afirmar envio. É necessário conectar um serviço real de entrega antes de ativar recuperação. Nenhum provider falso pode ser habilitado por variável de produção; testes usam injeção de dependência exclusivamente em processo isolado. A chave VIP_MEDIA_SECRET (forte, já existente) protege o HMAC. Não rotacioná-la sem considerar desafios em andamento.

As tabelas novas recebem RLS no PostgreSQL e não têm política pública. Não foi executado DDL contra public durante testes. SigiloPay, SMS/WhatsApp e Storage reais não foram exercitados.

## Arquivos desta etapa
- Frontend de pagamento/acesso: `app.js`, `index.html`, `style.css`, `vip.html` (somente link de recuperação no estado bloqueado).
- Backend: `backend/server.js`, `backend/services/orders.js`, `backend/services/buyer-phone.js`, `backend/services/buyer-recovery.js`, `backend/services/otp-provider.js`.
- Banco: `backend/db/database.js`, `backend/db/postgres.js`, `backend/db/schema.buyer.sql`.
- Testes: `backend/test-suite.js`, `backend/tests/run.js`, `backend/tests/postgres.js`, `backend/tests/content-postgres.js`, `backend/tests/buyer-recovery.js`, `backend/tests/buyer-browser.js`.
- Este relatório: `backend/BUYER-ACCESS.md`.

QA em Chrome com toque emulado: 320, 375, 390 e 430 px. Foram usados pedidos e dados sintéticos somente em SQLite isolado. QR decodificado pelo navegador, botão Copiar >=44px, sem overflow horizontal, cobrança pendente retomada após refresh, confirmação via webhook mock, token persistido antes de abrir VIP, refresh VIP, outro navegador bloqueado, telefone sozinho bloqueado, FAILED/PENDING/PAID sem entitlement bloqueados e entitlement expirado bloqueado. Recuperação desativada retorna indisponibilidade verdadeira.

A comparação por hashes com o snapshot anterior confirmou que os arquivos de admin, providers de pagamento, feed VIP, carousel, crop, teaser, likes e Storage permaneceram intactos. Em arquivos compartilhados, as alterações ficaram nos blocos de pagamento/acesso. Nenhuma alteração no .env, nenhum SMS/WhatsApp, nenhuma cobrança real.

## Resultado final
- npm test: passou (inclui admin, providers, autorização, recuperação, feed e regressões existentes).
- npm run check: 65 arquivos JavaScript passaram.
- npm run audit:security: 367/367 verificações passaram.
- PostgreSQL/Supabase real: suíte passou, inclusive recuperação e limites; somente schema temporário, removido no finally.
- QA mobile de pagamento/acesso: 320/375/390/430 passou.
- PAYMENT_PROVIDER local permaneceu mock. SigiloPay e entrega SMS/WhatsApp reais não foram testados/ativados.
