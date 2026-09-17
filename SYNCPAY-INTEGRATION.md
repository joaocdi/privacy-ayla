# SyncPay na Ayla

A implementação é a mesma da Joice (provider, webhook assinado, conciliação, idempotência). O que muda é só a configuração, e ela é aplicada pelo `ativar_syncpay_ayla.bat`.

## Conta compartilhada, webhook separado

A SyncPay **não aceita URL de retorno por transação**: a URL fica no cadastro do webhook, na conta. Por isso a Ayla tem **webhook próprio**, com **segredo próprio**:

- URL: `https://privacy-ayla.vercel.app/api/webhooks/syncpay`
- Evento: `transaction`, `trigger_all_products: true`
- Segredo: `SYNCPAY_WEBHOOK_SECRET` (só na Production da Ayla) · ID: `SYNCPAY_WEBHOOK_ID`

Como a conta é a mesma, **os dois webhooks recebem as transações das duas criadoras**. Cada aplicação só reconhece o `identifier` que está no próprio banco: a transação da outra cai em "transação desconhecida" (HTTP 404) e **nunca vira acesso**. É o mesmo comportamento que a Joice já tinha para entrega fora de ordem.

## Variáveis

| Ambiente | PAYMENT_PROVIDER | Observação |
| --- | --- | --- |
| Production | `syncpay` | com `SYNCPAY_CLIENT_ID`, `SYNCPAY_CLIENT_SECRET`, `SYNCPAY_WEBHOOK_SECRET`, `SYNCPAY_WEBHOOK_ID` |
| Preview | `staging` | pagamento simulado, `APP_ENV=staging`, schema `staging_ayla_preview`; nenhuma credencial real |

`mock` continua **proibido** em produção. Sem provider válido, o site inteiro continua no ar e só o checkout responde 503 — não existe queda global nem fallback silencioso.

## Produtos

`ayla_monthly` R$ 9,90 (30 dias) · `ayla_quarterly` R$ 19,90 (90 dias) · `ayla_semester` R$ 29,90 (180 dias) · `ayla_whatsapp_unlock` R$ 7,90 (contato, sem VIP) · `ayla_tip` mínimo R$ 5,00. O preço vem sempre do backend: o navegador manda só o `productId` (e os centavos do mimo, validados no servidor).

## Testes

`backend/tests/ayla-production.js` roda o handler da Vercel em PostgreSQL com a SyncPay simulada: páginas no ar sem provider, checkout 503, preços, PIX, webhook (sem assinatura, ignorado, divergente, desconhecido, pago), idempotência, WhatsApp separado do VIP e RLS. `backend/tests/ativar-syncpay-ayla.js` cobre o script de ativação com SyncPay e Vercel simuladas.
