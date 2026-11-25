// The sample "shop-website" checkout page, before and after a redesign that breaks the mirrored layout.
// Used by samples.mjs (the sample report) and demo-dashboard.mjs (a project to try the dashboard on).
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const thumb = c => `<img class="thumb" alt="" style="background:${c}" src="${GIF}">`;

export const INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop checkout</title><link rel="stylesheet" href="style.css"></head>
<body><main class="card"><h1>Order summary</h1>
<div class="item">${thumb('linear-gradient(135deg,#9874fe,#3792fd)')}<div class="title">Canvas tote bag<br><small class="muted">Qty 1</small></div><span class="price-badge">$24.00</span></div>
<div class="item">${thumb('linear-gradient(135deg,#f04e7f,#df6e07)')}<div class="title">Ceramic mug set<br><small class="muted">Qty 2</small></div><span class="price-badge">$36.00</span></div>
<div class="row"><span>Subtotal</span><span>$60.00</span></div>
<div class="row"><span class="muted ship">Free shipping</span><span class="muted">$0.00</span></div>
<div class="row total"><span>Total</span><span>$54.00</span></div>
<button class="place-order">Place order</button></main></body></html>
`;

export const CSS = `body{font:15px/1.45 system-ui,"Segoe UI",Tahoma,Arial,sans-serif;margin:0;padding:24px;background:#f3f3fb;color:#1c1b2b}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e4e2f0;border-radius:12px;padding:16px}
h1{font-size:17px;margin:0 0 10px}
.item{position:relative;display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #e4e2f0;border-radius:10px;margin-bottom:8px}
.thumb{width:48px;height:48px;border-radius:8px;flex:none}
.title{flex:1;margin-inline-end:84px}
.price-badge{position:absolute;top:12px;inset-inline-end:12px;padding:2px 8px;border-radius:999px;background:#eef2ff;font-weight:600;font-size:13px}
.row{display:flex;justify-content:space-between;padding:4px 0}
.total{border-top:1px solid #e4e2f0;margin-top:4px;padding-top:8px;font-weight:700}
.muted{color:#6a6784}
.place-order{display:block;margin:12px 0 0 auto;min-width:148px;min-height:44px;padding:0 14px;border:0;border-radius:10px;background:#2f6fed;color:#fff;font:600 14px system-ui}
`;

/** The redesign: a physical `right` where a logical side belonged, faded muted text, and a fixed-width button with a longer label. */
export const HEAD_INDEX = INDEX.replace('>Place order<', '>Confirm order and complete payment<');
export const HEAD_CSS = CSS
  .replace('inset-inline-end:12px', 'right:12px')
  .replace('.muted{color:#6a6784}', '.muted{color:#c9c7e4}')
  .replace('.place-order{display:block;margin:12px 0 0 auto;min-width:148px;', '.place-order{display:block;margin:12px 0 0 auto;width:148px;overflow:hidden;white-space:nowrap;');

/**
 * A project that has been bitten before: four files call an old totals function, and three fix commits each swapped it for the new one.
 * That is what "Learn from history" finds. Written before everything else, so it is history and not part of the branch being reviewed.
 */
const totals = (name, call) => `export function ${name}Totals(cart, items) {\n  const t = cart.${call}(items);\n  return t;\n}\n`;
export function shopHistory(repo) {
  repo.commit(Object.fromEntries(['cart', 'coupons', 'orders', 'checkout'].map(f => [`src/${f}.js`, totals(f, 'legacyTotals')])), 'Cart: totals for the cart, coupons, orders and checkout');
  repo.commit({ 'src/coupons.js': totals('coupons', 'totals') }, 'fix: the coupon page showed stale totals');
  repo.commit({ 'src/orders.js': totals('orders', 'totals') }, 'fix: the order email used the old totals before tax');
  repo.commit({ 'src/cart.js': totals('cart', 'totals') }, 'fix: the cart badge ignored shipping in the totals');
}

/**
 * The sample project the dashboard is tried on: "shop-website", a throwaway repository with some history (see above), planted mistakes
 * (a committed key, risky code, a guard removed, a look-alike package) and then the checkout redesign above, which also calls the old
 * totals function once more. Running its tests and pages is switched on for it, so every button works.
 * `fx` is the core's test fixtures module and `core` its index (both from the build).
 */
export function shopProject(fx, core) {
  const { repo } = fx.plantedRepo('shop-website', shopHistory);
  const base = repo.commit({ 'index.html': INDEX, 'style.css': CSS }, 'Checkout: order summary');
  const head = repo.commit({ 'index.html': HEAD_INDEX, 'style.css': HEAD_CSS, 'src/summary.js': 'export const summary = (cart, items) => cart.legacyTotals(items).total;\n' }, 'Checkout: redesign the order summary card');
  core.setRepoSettings(repo.dir, { allow: true });
  return { repo, base, head };
}
