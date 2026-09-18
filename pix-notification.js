(function (global) {
  'use strict';
  const store = global.AylaCheckouts || global.JoiceCheckouts;
  const bell = document.getElementById('pixNotificationBell');
  const badge = document.getElementById('pixNotificationBadge');
  const panel = document.getElementById('pixNotificationPanel');
  if (!store || !bell || !badge || !panel) return;
  const labels = {
    ayla_monthly: '1 mês', ayla_quarterly: '3 meses', ayla_semester: '6 meses', ayla_whatsapp_unlock: 'Contato WhatsApp',
    monthly: '1 mês', quarterly: '3 meses', semester: '6 meses', whatsapp_unlock: 'Contato WhatsApp'
  };
  const seenPending = new Set();
  const seenExpired = new Set();
  const priorPending = new Set(store.list().map(item => item.payment?.orderId).filter(Boolean));
  let version = 0, poll = null, clock = null;
  function close() { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); }
  bell.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    bell.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('click', event => {
    if (!panel.hidden && !panel.contains(event.target) && !bell.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  function countdown(expiresAt) {
    clearInterval(clock);
    if (!expiresAt) return;
    const node = document.getElementById('pixNotificationTime');
    const raw = String(expiresAt).replace(' ', 'T');
    const end = Date.parse(raw + (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z'));
    if (!node || !Number.isFinite(end)) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      node.textContent = seconds ? String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : '';
      if (!seconds) { clearInterval(clock); refresh(); }
    };
    tick();
    if (end > Date.now()) clock = setInterval(tick, 1000);
  }
  function hide() {
    clearInterval(clock); close();
    bell.hidden = true; badge.hidden = true; panel.replaceChildren();
  }
  async function refresh() {
    const call = ++version;
    clearTimeout(poll);
    const items = store.list();
    if (!items.length) { hide(); return; }
    const states = (await Promise.all(items.map(async item => {
      if (!item.payment?.orderId) return { item, state: { status: 'CREATING' } };
      try { return { item, state: await global.pendingPixStatus(item) }; }
      catch (error) {
        if (error.status === 403 || error.status === 404) { store.remove(item); return null; }
        return { item, state: { status: 'UNKNOWN' } };
      }
    }))).filter(Boolean);
    if (call !== version) return;
    for (const entry of states) if (entry.state.status === 'PAID' && !entry.state.needsClaim) store.remove(entry.item);
    const tokens = new Set(store.list().map(item => item.token));
    const usable = states.filter(entry => tokens.has(entry.item.token));
    const selected = store.selected();
    const pick = test => {
      const matches = usable.filter(entry => test(entry.state));
      return matches.find(entry => entry.item.token === selected?.token) || matches.at(-1);
    };
    const chosen = usable.find(entry => entry.item.token === selected?.token &&
      (entry.state.status === 'PENDING' || entry.state.status === 'EXPIRED' ||
       (entry.state.status === 'PAID' && entry.state.needsClaim)));
    const current = chosen || pick(state => state.status === 'PENDING')
      || pick(state => state.status === 'PAID' && state.needsClaim)
      || pick(state => state.status === 'EXPIRED')
      || pick(state => state.status === 'CREATING' || state.requiresReview);
    if (!current) { hide(); return; }
    const { item, state } = current;
    const pending = state.status === 'PENDING', paid = state.status === 'PAID', expired = state.status === 'EXPIRED';
    const open = !panel.hidden;
    bell.hidden = false; badge.hidden = !pending && !expired;
    bell.setAttribute('aria-label', paid ? 'Pagamento confirmado' : expired ? 'PIX expirado' : pending ? 'Um PIX pendente' : 'Compra em andamento');
    panel.replaceChildren();
    const header = document.createElement('div'); header.className = 'pix-notification-header';
    const title = document.createElement('strong');
    title.textContent = paid ? 'Pagamento confirmado' : expired ? 'PIX expirado' : pending ? 'PIX pendente' : 'Compra em andamento';
    header.append(title);
    if (pending && state.expiresAt) {
      const time = document.createElement('span'); time.id = 'pixNotificationTime'; header.append(time);
    }
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'pix-notification-close';
    dismiss.setAttribute('aria-label', 'Fechar notificações'); dismiss.textContent = '×'; dismiss.onclick = close; header.append(dismiss);
    const detail = document.createElement('p'); detail.className = 'pix-notification-detail';
    const amount = Number(state.amount);
    detail.textContent = (labels[item.productId] || 'Compra') +
      (Number.isFinite(amount) ? ' · ' + amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '');
    const action = document.createElement('button'); action.type = 'button'; action.id = 'pixNotificationContinue';
    action.className = 'pix-notification-action';
    action.textContent = paid ? 'Criar meu acesso' : expired ? 'Gerar novo PIX' : pending ? 'Continuar pagamento' : 'Retomar compra';
    action.onclick = () => {
      if (paid) return global.openPaidAccount(item, true);
      if (!item.payment?.orderId) return global.openCheckout(item.productId, item.token);
      location.assign('/continuar?order=' + encodeURIComponent(item.payment.orderId) + (expired ? '&regen=1' : ''));
    };
    panel.append(header, detail, action);
    panel.hidden = !open; bell.setAttribute('aria-expanded', String(open));
    countdown(pending ? state.expiresAt : null);
    if (expired && !seenExpired.has(item.payment?.orderId)) {
      seenExpired.add(item.payment?.orderId); global.FunnelAnalytics?.track('pix_expired', item.productId, item.payment?.orderId);
    }
    if (pending && priorPending.has(item.payment?.orderId) && !seenPending.has(item.payment?.orderId)) {
      seenPending.add(item.payment?.orderId); global.FunnelAnalytics?.track('pix_pending_return', item.productId, item.payment?.orderId);
    }
    if ((pending || state.status === 'CREATING') && !document.hidden) poll = setTimeout(refresh, 15000);
  }
  global.PixNotifications = { refresh };
})(window);
