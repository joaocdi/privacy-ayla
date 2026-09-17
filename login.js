/* ==========================================================================
   ENTRAR.
   O navegador não conhece nenhuma chave do Supabase: manda e-mail e senha para
   o nosso backend, que autentica no Supabase Auth, confere a role e devolve um
   cookie de sessão HttpOnly. Nada de token guardado em localStorage.
   ========================================================================== */

const API_BASE = location.protocol === 'file:'
  || (['localhost', '127.0.0.1'].includes(location.hostname) && ['5500', '5501'].includes(location.port))
  ? 'http://localhost:3333' : '';

const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');
const submit = document.getElementById('submit');
const password = document.getElementById('password');
const toggle = document.getElementById('toggle');

function say(text, ok = false) {
  message.textContent = text;
  message.classList.toggle('is-ok', ok);
}

toggle.addEventListener('click', () => {
  const showing = password.type === 'text';
  password.type = showing ? 'password' : 'text';
  toggle.textContent = showing ? 'Mostrar' : 'Ocultar';
  toggle.setAttribute('aria-pressed', String(!showing));
  toggle.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
  password.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  if (!email || !password.value) return say('Preencha e-mail e senha.');

  submit.disabled = true;
  say('Entrando…');
  try {
    const response = await fetch(API_BASE + '/api/admin/login-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: password.value }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível entrar.');
    say('Pronto. Levando você de volta…', true);
    // A senha não fica no campo depois do sucesso.
    password.value = '';
    const back = new URLSearchParams(location.search).get('r');
    location.assign(back === '/vip' ? '/vip' : '/');
  } catch (error) {
    say(error.message || 'Não foi possível entrar.');
    submit.disabled = false;
  }
});
