document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const input = document.getElementById('secret');
  const message = document.getElementById('message');
  button.disabled = true;
  message.textContent = 'Entrando…';
  try {
    const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: input.value }) });
    input.value = '';
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível entrar.');
    location.assign('/admin');
  } catch (error) { message.textContent = error.message || 'Falha de conexão.'; }
  finally { button.disabled = false; }
});
