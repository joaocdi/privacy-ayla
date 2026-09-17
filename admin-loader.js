// Visitor cost is limited to checking the server session, never loading editors.
(() => {
  const base = location.protocol === 'file:' || (['localhost','127.0.0.1'].includes(location.hostname) && ['5500','5501'].includes(location.port)) ? 'http://localhost:3333' : '';
  // Visitante: a conferência de sessão sai do caminho crítico do primeiro
  // desenho. O feed carrega primeiro; o painel entra depois, se for a criadora.
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1200));
  window.AylaAdminSession = new Promise(resolve => idle(() => resolve(
    fetch(base + '/api/admin/me', {credentials:'include', signal:AbortSignal.timeout(8000)})
      .then(response => response.ok ? response.json() : null).catch(() => null)), { timeout: 2500 }));
  window.AylaAdminSession.then(async me => {
    if (!me?.admin) return;
    await new Promise((resolve, reject) => { const tools = document.createElement('script'); tools.src = base + '/image-tools.js'; tools.onload = resolve; tools.onerror = reject; document.head.append(tools); });
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + '/admin-mode.css?v=carousel-1';
    const script = document.createElement('script'); script.src = base + '/admin-mode.js?v=lazy-admin-1';
    document.head.append(css); document.head.append(script);
  }).catch(() => {});
})();
