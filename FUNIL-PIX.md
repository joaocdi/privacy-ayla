# Funil e retomada de PIX — Ayla

Analytics first-party grava somente eventos permitidos em `analytics_events`, no schema Ayla. O navegador usa um identificador anônimo de sessão e envia eventos para `/api/analytics/event`, com validação e limite de requisições. A criação e confirmação de pagamento são registradas pelo servidor. O painel da criadora mostra Hoje, 7 e 30 dias, conversões e distribuição por produto.

O navegador guarda a referência do pedido e o token de posse; o código PIX não é persistido. `/continuar` consulta o status e busca QR/copia-e-cola no backend. A cobrança nova recebe outro token e outra order. O valor vem sempre do catálogo do backend. Um pedido pago mantém o token de reivindicação até o comprador criar seu acesso; deixa de aparecer como PIX pendente.

O contador usa somente `expires_at` persistido. A SyncPay pode não fornecer esse campo: nesse caso a tela informa que o prazo não foi comunicado e não inventa prazo nem oferece regeneração automática. A confirmação pelo webhook continua sendo a fonte da verdade. O painel conta como expirado um PIX pendente com `expires_at` real vencido, mesmo antes de uma transição física de status.

Web Push exige `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` (por exemplo, `mailto:suporte@dominio`) no backend. Gere um par distinto para Ayla, configure as variáveis na Vercel e só então a opção de consentimento aparecerá depois do PIX. O envio implementado é a confirmação de pagamento; lembrete agendado depende de um agendador confiável e ficou pendente. E-mail permanece desabilitado porque não há serviço transacional configurado; não se coleta e-mail antes do PIX.

Validação local, sem compra real: `node backend/tests/funnel-recovery.js`, `node backend/tests/tips-browser.js`, `cd backend; npm test; npm run audit:security`.
