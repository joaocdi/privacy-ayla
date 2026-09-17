// One key per attempt avoids read/modify/write races between different tabs.
// These claims prove possession only; the server still checks payment + ownership.
(function (global) {
  'use strict';
  const PREFIX = 'ayla.buyer.checkout.';
  const LEGACY = 'ayla.buyer.pending';
  const SELECTED = 'ayla.buyer.selected';
  const memory = new Map();
  const products = ['ayla_monthly', 'ayla_quarterly', 'ayla_semester', 'ayla_whatsapp_unlock'];
  function valid(item) {
    return item && products.includes(item.productId) && /^[a-f0-9]{64}$/.test(item.token || '')
      && (!item.payment?.orderId || /^ord_[a-f0-9]{48}$/.test(item.payment.orderId));
  }
  function save(item) {
    if (!valid(item)) throw new Error('Compra inválida.');
    const key = PREFIX + item.token;
    let old;
    try { old = JSON.parse(localStorage.getItem(key)); } catch (_) {}
    const value = { ...old, ...item, createdAt: old?.createdAt || item.createdAt || Date.now() };
    if(value.payment?.pix)value.payment={...value.payment,pix:undefined}; // retrieve the code from the server after validating possession
    localStorage.setItem(key, JSON.stringify(value));
    memory.set(key, value);
    return value;
  }
  function migrate() {
    try {
      const raw = localStorage.getItem(LEGACY);
      const old = JSON.parse(raw);
      if (!valid(old)) return;
      save(old);
      if (!sessionStorage.getItem(SELECTED)) sessionStorage.setItem(SELECTED, old.token);
      if (localStorage.getItem(LEGACY) === raw) localStorage.removeItem(LEGACY);
    } catch (_) { /* Keep legacy claims when storage is temporarily unavailable. */ }
  }
  function list() {
    migrate();
    try {
      const found = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(PREFIX)) continue;
        try {
          const item = JSON.parse(localStorage.getItem(key));
          if (valid(item) && key === PREFIX + item.token) { if(item.payment?.pix){item.payment={...item.payment,pix:undefined};localStorage.setItem(key,JSON.stringify(item));} found.push(item); }
        } catch (_) {}
      }
      return found.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    } catch (_) { return [...memory.values()]; }
  }
  function select(item) {
    if (!valid(item)) return;
    try { sessionStorage.setItem(SELECTED, item.token); } catch (_) {}
  }
  function selected() {
    const items = list();
    const orderId = new URLSearchParams(location.search).get('order');
    if (orderId) return items.find(item => item.payment?.orderId === orderId) || null;
    let token;
    try { token = sessionStorage.getItem(SELECTED); } catch (_) {}
    return items.find(item => item.token === token) || (items.length === 1 ? items[0] : null);
  }
  function remove(item) {
    if (!valid(item)) return;
    localStorage.removeItem(PREFIX + item.token);
    memory.delete(PREFIX + item.token);
    try {
      if (sessionStorage.getItem(SELECTED) === item.token) sessionStorage.removeItem(SELECTED);
      if (sessionStorage.getItem('ayla.checkout.' + item.productId) === item.token) sessionStorage.removeItem('ayla.checkout.' + item.productId);
    } catch (_) {}
  }
  global.AylaCheckouts = { list, save, select, selected, remove, prefix: PREFIX };
})(window);
