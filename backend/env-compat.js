'use strict';
/**
 * Nomes novos do painel do Supabase -> nomes que o backend já usa.
 *
 *   SUPABASE_PUBLISHABLE_KEY  -> SUPABASE_ANON_KEY
 *   SUPABASE_SECRET_KEY       -> SUPABASE_SERVICE_ROLE_KEY
 *
 * O nome antigo, quando definido, sempre vence: nada muda para quem já usa.
 *
 * Atenção: o backend chama Auth e Storage por HTTP com o cabeçalho
 * `Authorization: Bearer <chave>`. As chaves novas `sb_publishable_...` e
 * `sb_secret_...` não são JWT, e o Storage recusa esse formato em chamadas
 * diretas. Por isso o recomendado continua sendo a aba
 * "Legacy anon, service_role API keys" (chaves que começam com eyJ).
 * O script backend/scripts/configurar-ayla.js testa isso antes de gravar.
 * Nenhum valor é registrado em log.
 */
const PAIRS = [
  ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']
];

function apply(env = process.env) {
  for (const [current, modern] of PAIRS) {
    if (!String(env[current] || '').trim() && String(env[modern] || '').trim()) env[current] = env[modern];
  }
  return env;
}

/** true quando a chave é do formato novo (não-JWT). */
function isOpaqueKey(value) {
  return /^sb_(publishable|secret)_/.test(String(value || '').trim());
}

apply();

module.exports = { apply, isOpaqueKey, PAIRS };
