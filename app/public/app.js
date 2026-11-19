// Tiny Shop front-end: product list, cart (localStorage), checkout, confirmation.
// Prices are integer cents everywhere, so totals never suffer float rounding.
(function () {
  'use strict';

  const PRODUCTS = [
    { id: 'headphones', name: 'Wireless Headphones', price: 8999, icon: '🎧', blurb: 'Bluetooth over-ear, 30h battery.' },
    { id: 'cable', name: 'USB-C Cable', price: 1250, icon: '🔌', blurb: '1m braided, 100W fast charge.' },
    { id: 'keyboard', name: 'Mechanical Keyboard', price: 7400, icon: '⌨️', blurb: 'Hot-swap switches, backlit.' },
    { id: 'lamp', name: 'Desk Lamp', price: 3495, icon: '💡', blurb: 'Warm light, three brightness levels.' },
    { id: 'notebook', name: 'Notebook', price: 999, icon: '📓', blurb: '192 dotted pages, lay-flat binding.' },
    { id: 'bottle', name: 'Water Bottle', price: 1995, icon: '🚰', blurb: 'Insulated steel, 750ml, keeps cold 24h.' },
  ];
  const BY_ID = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));
  const CART_KEY = 'tiny-shop-cart';

  function formatMoney(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
      const cart = {};
      for (const [id, qty] of Object.entries(raw)) {
        if (BY_ID[id] && Number.isInteger(qty) && qty > 0) cart[id] = qty;
      }
      return cart;
    } catch {
      return {};
    }
  }

  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }

  function cartCount(cart) {
    return Object.values(cart).reduce((a, b) => a + b, 0);
  }

  function cartTotal(cart) {
    return Object.entries(cart).reduce((sum, [id, qty]) => sum + BY_ID[id].price * qty, 0);
  }

  function cartItems(cart) {
    return Object.entries(cart).map(([id, qty]) => ({ id, qty, price: BY_ID[id].price }));
  }

  // ---- Shop page ----
  function renderProducts() {
    const list = document.getElementById('product-list');
    if (!list) return;
    list.innerHTML = '';
    for (const p of PRODUCTS) {
      const card = document.createElement('article');
      card.className = 'product-card';
      card.innerHTML =
        '<div class="product-icon" aria-hidden="true">' + p.icon + '</div>' +
        '<h3>' + p.name + '</h3>' +
        '<p>' + p.blurb + '</p>' +
        '<div class="product-price">' + formatMoney(p.price) + '</div>';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button primary';
      btn.textContent = 'Add to cart';
      btn.setAttribute('data-add', p.id);
      btn.addEventListener('click', () => {
        const cart = loadCart();
        cart[p.id] = (cart[p.id] || 0) + 1;
        saveCart(cart);
        renderCart();
      });
      card.appendChild(btn);
      list.appendChild(card);
    }
  }

  function renderCart() {
    const countEl = document.getElementById('cart-count');
    const cart = loadCart();
    if (countEl) countEl.textContent = String(cartCount(cart));

    const emptyEl = document.getElementById('cart-empty');
    const table = document.getElementById('cart-table');
    const footer = document.getElementById('cart-footer');
    const rows = document.getElementById('cart-rows');
    const totalEl = document.getElementById('cart-total');
    if (!table || !rows) return;

    const count = cartCount(cart);
    const empty = count === 0;
    if (emptyEl) emptyEl.hidden = !empty;
    table.hidden = empty;
    if (footer) footer.hidden = empty;
    if (empty) return;

    rows.innerHTML = '';
    for (const [id, qty] of Object.entries(cart)) {
      const p = BY_ID[id];
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.textContent = p.name;
      const qtyTd = document.createElement('td');
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'qty-btn';
      minus.textContent = '−';
      minus.setAttribute('aria-label', 'Decrease quantity of ' + p.name);
      minus.addEventListener('click', () => changeQty(id, -1));
      const qtyLabel = document.createElement('span');
      qtyLabel.textContent = ' ' + qty + ' ';
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'qty-btn';
      plus.textContent = '+';
      plus.setAttribute('aria-label', 'Increase quantity of ' + p.name);
      plus.addEventListener('click', () => changeQty(id, 1));
      qtyTd.append(minus, qtyLabel, plus);
      const priceTd = document.createElement('td');
      priceTd.textContent = formatMoney(p.price);
      const lineTd = document.createElement('td');
      lineTd.textContent = formatMoney(p.price * qty);
      const rmTd = document.createElement('td');
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove-btn';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => {
        const c = loadCart();
        delete c[id];
        saveCart(c);
        renderCart();
      });
      rmTd.appendChild(rm);
      tr.append(nameTd, qtyTd, priceTd, lineTd, rmTd);
      rows.appendChild(tr);
    }
    if (totalEl) totalEl.textContent = formatMoney(cartTotal(cart));
  }

  function changeQty(id, delta) {
    const cart = loadCart();
    const next = (cart[id] || 0) + delta;
    if (next <= 0) delete cart[id];
    else cart[id] = next;
    saveCart(cart);
    renderCart();
  }

  // ---- Checkout page ----
  function renderSummary() {
    const linesEl = document.getElementById('summary-lines');
    const totalEl = document.getElementById('summary-total');
    const emptyEl = document.getElementById('summary-empty');
    if (!linesEl) return;
    const cart = loadCart();
    const count = cartCount(cart);
    if (emptyEl) emptyEl.hidden = count !== 0;
    linesEl.innerHTML = '';
    for (const [id, qty] of Object.entries(cart)) {
      const li = document.createElement('li');
      li.textContent = BY_ID[id].name + ' × ' + qty + ' — ' + formatMoney(BY_ID[id].price * qty);
      linesEl.appendChild(li);
    }
    if (totalEl) totalEl.textContent = formatMoney(cartTotal(cart));
    const placeBtn = document.getElementById('place-order-btn');
    if (placeBtn) placeBtn.disabled = count === 0;
  }

  function showCheckoutError(message) {
    const el = document.getElementById('checkout-error');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  async function placeOrder() {
    // SEED-TARGET: checkout form lookup. The form's id in checkout.html is
    // "checkout-form". (The demo bug swaps this for a wrong id.)
    const form = document.getElementById('checkout-form');
    if (!form.reportValidity()) return;

    const cart = loadCart();
    if (cartCount(cart) === 0) {
      showCheckoutError('Your cart is empty.');
      return;
    }
    const placeBtn = document.getElementById('place-order-btn');
    placeBtn.disabled = true;
    placeBtn.textContent = 'Placing order…';
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('field-name').value.trim(),
          email: document.getElementById('field-email').value.trim(),
          address: document.getElementById('field-address').value.trim(),
          items: cartItems(cart),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Order failed');
      localStorage.removeItem(CART_KEY);
      window.location.href = '/confirmation.html?order=' + encodeURIComponent(data.orderId);
    } catch (err) {
      showCheckoutError('Could not place the order: ' + err.message);
      placeBtn.disabled = false;
      placeBtn.textContent = 'Place order';
    }
  }

  function initCheckout() {
    renderSummary();
    const placeBtn = document.getElementById('place-order-btn');
    if (placeBtn) placeBtn.addEventListener('click', placeOrder);
  }

  // ---- Confirmation page ----
  async function initConfirmation() {
    const loading = document.getElementById('confirmation-loading');
    const details = document.getElementById('confirmation-details');
    const errorEl = document.getElementById('confirmation-error');
    if (!loading || !details) return;
    const orderId = new URLSearchParams(window.location.search).get('order');
    if (!orderId) {
      loading.hidden = true;
      errorEl.textContent = 'No order number in the link.';
      errorEl.hidden = false;
      return;
    }
    try {
      const res = await fetch('/api/orders/' + encodeURIComponent(orderId));
      const order = await res.json();
      if (!res.ok) throw new Error(order.error || 'Order not found');
      document.getElementById('confirmation-name').textContent = order.name;
      document.getElementById('confirmation-number').textContent = order.orderId;
      document.getElementById('confirmation-items').textContent =
        order.items.map((i) => BY_ID[i.id].name + ' × ' + i.qty).join(', ');
      document.getElementById('confirmation-total').textContent = formatMoney(order.total);
      loading.hidden = true;
      details.hidden = false;
    } catch (err) {
      loading.hidden = true;
      errorEl.textContent = 'Could not load the order: ' + err.message;
      errorEl.hidden = false;
    }
  }

  // ---- Boot ----
  document.addEventListener('DOMContentLoaded', () => {
    renderProducts();
    renderCart();
    initCheckout();
    initConfirmation();
    const cartBtn = document.getElementById('cart-button');
    if (cartBtn) {
      cartBtn.addEventListener('click', () => {
        const panel = document.getElementById('cart-panel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth' });
      });
    }
  });
})();
