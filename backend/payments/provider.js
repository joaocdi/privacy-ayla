require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
/**
 * Seleção do provider de pagamento.
 *
 * Regras:
 *  - mock é PROIBIDO em produção e nunca é carregado lá (nem por padrão);
 *  - sem provider válido em produção NÃO há fallback: o checkout fica
 *    indisponível (503) e o resto do site (HOME, login, admin, VIP) continua no ar;
 *  - fora de produção, sem PAYMENT_PROVIDER, o padrão continua sendo mock.
 */
const SUPPORTED = ['mock', 'sigilopay', 'syncpay', 'staging'];
const production = process.env.NODE_ENV === 'production'
  || process.env.APP_ENV === 'production'
  || process.env.VERCEL_ENV === 'production';   // qualquer um destes já vale como produção
const name = String(process.env.PAYMENT_PROVIDER || (production ? '' : 'mock')).trim();

function unavailableProvider(reason) {
  const fail = () => Object.assign(new Error('Pagamento indisponível no momento.'), { status: 503 });
  return {
    name: 'unavailable', unavailable: true, reason, requiresClient: false,
    configuration() { throw fail(); },
    async createPixPayment() { throw fail(); },
    async validateWebhook() { return false; },
    parseWebhook() { throw fail(); }
  };
}

function load() {
  if (!name) throw new Error('PAYMENT_PROVIDER ausente em produção (defina syncpay).');
  if (!SUPPORTED.includes(name)) throw new Error('PAYMENT_PROVIDER must be mock, sigilopay, syncpay or staging');
  if (name === 'mock' && production) throw new Error('PAYMENT_PROVIDER=mock é proibido em produção; checkout desativado.');
  return require('./' + name + '-provider');
}

let provider;
try {
  provider = load();
} catch (error) {
  if (!production) throw error; // desenvolvimento/teste: erro de configuração continua explícito
  console.error('[pagamento] checkout indisponível: ' + error.message);
  provider = unavailableProvider(error.message);
}
module.exports = provider;
