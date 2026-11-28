/**
 * What runs inside the page: measurements, not opinions. Written as plain JavaScript in a string (String.raw keeps the backslashes),
 * because the core has no DOM types and no dependencies. No backticks and no dollar-brace in here.
 */
export interface InPageProblem {
  kind: 'hscroll' | 'clip' | 'overlap' | 'contrast' | 'noalt' | 'noname' | 'nolabel' | 'nolang' | 'heading' | 'tabindex' | 'dupid' | 'blank';
  path: string;
  detail: string;
  /** Class and id names of the elements involved, to find the rule or the markup that made them. */
  tokens: string[];
  /** Where it is on the page, in CSS pixels from the top left, as laid out (the overlap is the area the two share). */
  box?: { x: number; y: number; w: number; h: number };
}
export interface InspectResult { problems: InPageProblem[]; textLength: number }

export const INSPECT_SRC = String.raw`(function () {
  var problems = [];
  var vw = window.innerWidth;
  function cssPath(el) {
    var parts = [], n = el;
    for (var d = 0; n && n.nodeType === 1 && d < 5; d++, n = n.parentElement) {
      var s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      var cls = Array.prototype.slice.call(n.classList, 0, 2).join('.');
      if (cls) s += '.' + cls;
      var sibs = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, function (c) { return c.tagName === n.tagName; }) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function tokens(el) {
    var t = [];
    Array.prototype.forEach.call(el.classList, function (c) { t.push('.' + c); });
    if (el.id) t.push('#' + el.id);
    return t;
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, TITLE: 1 };
  var all = document.body ? Array.prototype.slice.call(document.body.querySelectorAll('*'), 0, 2500) : [];
  var info = [];
  all.forEach(function (el) {
    if (SKIP[el.tagName]) return;
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05) info.push({ el: el, cs: cs, r: r });
  });
  function ownText(el) { return Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && (n.textContent || '').trim().length > 0; }); }
  function snippet(el) { return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
  function box(r) { return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }

  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push({ kind: 'hscroll', path: 'html', detail: 'the page is ' + document.documentElement.scrollWidth + 'px wide in a ' + vw + 'px window, so it scrolls sideways', tokens: [] });
  }

  var clipped = 0;
  info.forEach(function (x) {
    if (clipped >= 8 || !ownText(x.el)) return;
    var el = x.el, cs = x.cs;
    var hide = function (v) { return v === 'hidden' || v === 'clip'; };
    var clamp = cs.getPropertyValue('-webkit-line-clamp');
    var cx = hide(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0;
    var cy = hide(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && (!clamp || clamp === 'none') && el.clientHeight > 0;
    if (cx || cy) {
      clipped++;
      problems.push({ kind: 'clip', path: cssPath(el), detail: 'the text "' + snippet(el) + '" is cut off (' + (cx ? el.scrollWidth + 'px of text in a ' + el.clientWidth + 'px box' : el.scrollHeight + 'px of text in a ' + el.clientHeight + 'px box') + ')', tokens: tokens(el), box: box(x.r) });
    }
  });

  var cand = info.filter(function (x) {
    var content = ['IMG', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'VIDEO', 'CANVAS'].indexOf(x.el.tagName) !== -1 || ownText(x.el);
    return content && x.cs.position !== 'fixed' && x.cs.position !== 'sticky' && x.cs.pointerEvents !== 'none';
  }).slice(0, 400);
  var seen = 0;
  for (var i = 0; i < cand.length && seen < 10; i++) {
    for (var j = i + 1; j < cand.length && seen < 10; j++) {
      var a = cand[i], b = cand[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      var ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      var iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix <= 2 || iy <= 2) continue;
      var area = ix * iy, small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (area < 150 || area < 0.25 * small) continue;
      var pa = cssPath(a.el), pb = cssPath(b.el);
      problems.push({ kind: 'overlap', path: pa + ' + ' + pb, detail: pa + ' and ' + pb + ' overlap by ' + Math.round(ix) + ' x ' + Math.round(iy) + ' px', tokens: tokens(a.el).concat(tokens(b.el)), box: { x: Math.round(Math.max(a.r.left, b.r.left)), y: Math.round(Math.max(a.r.top, b.r.top)), w: Math.round(ix), h: Math.round(iy) } });
      seen++;
    }
  }

  function parse(s) { var m = String(s).match(/[\d.]+/g) || []; return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] === undefined ? 1 : +m[3] }; }
  function lum(c) { function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  var darkCanvas = window.matchMedia('(prefers-color-scheme: dark)').matches && String(getComputedStyle(document.documentElement).colorScheme).indexOf('dark') !== -1;
  function backdrop(el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') return null;
      var c = parse(cs.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 0.99) break;
    }
    var base = darkCanvas ? { r: 18, g: 18, b: 18 } : { r: 255, g: 255, b: 255 };
    for (var k = layers.length - 1; k >= 0; k--) { var l = layers[k]; base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; }
    return base;
  }
  var cfail = [];
  info.slice(0, 700).forEach(function (x) {
    if (!ownText(x.el)) return;
    var fg = parse(x.cs.color);
    if (fg.a < 0.5) return;
    var bg = backdrop(x.el);
    if (!bg) return;
    var l1 = lum(fg), l2 = lum(bg);
    var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    var fs = parseFloat(x.cs.fontSize);
    var large = fs >= 24 || (fs >= 18.66 && parseInt(x.cs.fontWeight, 10) >= 700);
    var need = large ? 3 : 4.5;
    if (ratio < need) cfail.push({ x: x, ratio: ratio, need: need });
  });
  cfail.sort(function (p, q) { return p.ratio - q.ratio; }).slice(0, 8).forEach(function (f) {
    problems.push({ kind: 'contrast', path: cssPath(f.x.el), detail: 'the text "' + snippet(f.x.el) + '" is ' + f.ratio.toFixed(1) + ':1 against its background (needs ' + f.need + ':1)', tokens: tokens(f.x.el), box: box(f.x.r) });
  });

  var added = 0;
  Array.prototype.forEach.call(document.querySelectorAll('img'), function (img) {
    var r = img.getBoundingClientRect();
    if (added < 5 && r.width > 1 && !img.hasAttribute('alt') && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true') { added++; problems.push({ kind: 'noalt', path: cssPath(img), detail: 'an image has no alt text', tokens: tokens(img), box: box(r) }); }
  });
  added = 0;
  Array.prototype.forEach.call(document.querySelectorAll('button, a[href], [role=button]'), function (el) {
    var r = el.getBoundingClientRect();
    var has = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.querySelector('img[alt]:not([alt=""])');
    if (added < 5 && !has && r.width > 1 && r.height > 1) { added++; problems.push({ kind: 'noname', path: cssPath(el), detail: 'a control has no accessible name', tokens: tokens(el), box: box(r) }); }
  });
  added = 0;
  Array.prototype.forEach.call(document.querySelectorAll('input, select, textarea'), function (el) {
    var t = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].indexOf(t) !== -1) return;
    var r = el.getBoundingClientRect();
    var has = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length);
    if (added < 5 && !has && r.width > 1 && r.height > 1) { added++; problems.push({ kind: 'nolabel', path: cssPath(el), detail: 'a form field has no label', tokens: tokens(el), box: box(r) }); }
  });

  // From a sister tool's audit (D62): the page's language, the heading order, the keyboard order and ids used twice.
  if (!document.documentElement.getAttribute('lang')) problems.push({ kind: 'nolang', path: 'html', detail: 'the page has no language (<html lang>), so a screen reader guesses how to say it', tokens: [] });
  added = 0;
  var last = 0;
  Array.prototype.forEach.call(document.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (h) {
    var r = h.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    var n = Number(h.tagName.charAt(1));
    if (added < 5 && last && n > last + 1) { added++; problems.push({ kind: 'heading', path: cssPath(h), detail: 'the heading levels skip from h' + last + ' to h' + n + ' at "' + snippet(h) + '"', tokens: tokens(h), box: box(r) }); }
    last = n;
  });
  added = 0;
  Array.prototype.forEach.call(document.querySelectorAll('[tabindex]'), function (el) {
    var t = Number(el.getAttribute('tabindex'));
    var r = el.getBoundingClientRect();
    if (added < 5 && t > 0 && r.width > 0 && r.height > 0) { added++; problems.push({ kind: 'tabindex', path: cssPath(el), detail: 'tabindex="' + t + '" changes the order the keyboard moves in', tokens: tokens(el), box: box(r) }); }
  });
  var ids = {};
  var firstWith = {};
  Array.prototype.forEach.call(document.querySelectorAll('[id]'), function (el) { if (!el.id) return; ids[el.id] = (ids[el.id] || 0) + 1; if (!firstWith[el.id]) firstWith[el.id] = el; });
  added = 0;
  Object.keys(ids).forEach(function (id) {
    if (added < 5 && ids[id] > 1) { added++; problems.push({ kind: 'dupid', path: '#' + id.slice(0, 60), detail: 'the id "' + id.slice(0, 40) + '" is used ' + ids[id] + ' times, so a label or an aria reference finds only the first', tokens: tokens(firstWith[id]) }); }
  });

  var text = document.body ? document.body.innerText.trim().length : 0;
  if (document.body && text === 0 && !document.querySelector('img, canvas, svg, video, iframe')) {
    problems.push({ kind: 'blank', path: 'body', detail: 'the page shows nothing: no text and no image', tokens: [] });
  }
  return { problems: problems, textLength: text };
})()`;

/** Names a page takes input through: form fields, query keys in its links and in its address. */
export const PROBE_NAMES_SRC = String.raw`(function () {
  var names = [];
  function add(n) { if (n && /^[A-Za-z0-9_.-]{1,40}$/.test(n) && names.indexOf(n) === -1) names.push(n); }
  Array.prototype.forEach.call(document.querySelectorAll('form input[name], form textarea[name], form select[name]'), function (el) { if (['hidden', 'submit', 'button', 'password', 'file', 'checkbox', 'radio'].indexOf((el.getAttribute('type') || '').toLowerCase()) === -1) add(el.getAttribute('name')); });
  Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) { try { var u = new URL(a.href); if (u.origin === location.origin) u.searchParams.forEach(function (v, k) { add(k); }); } catch (e) {} });
  new URLSearchParams(location.search).forEach(function (v, k) { add(k); });
  var inputs = Array.prototype.filter.call(document.querySelectorAll('input, textarea'), function (el) { var t = (el.getAttribute('type') || 'text').toLowerCase(); return ['text', 'search', 'email', 'url', 'tel', ''].indexOf(t) !== -1 || el.tagName === 'TEXTAREA'; }).length;
  return { names: names.slice(0, 8), inputs: Math.min(inputs, 6) };
})()`;

/** Types the probe into the n-th text field and says whether the page turned it into an element. */
export const probeTypeSrc = (index: number, payload: string): string => String.raw`(async function () {
  var fields = Array.prototype.filter.call(document.querySelectorAll('input, textarea'), function (el) { var t = (el.getAttribute('type') || 'text').toLowerCase(); return ['text', 'search', 'email', 'url', 'tel', ''].indexOf(t) !== -1 || el.tagName === 'TEXTAREA'; });
  var el = fields[` + index + String.raw`];
  if (!el) return { found: false, name: '' };
  el.focus();
  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ` + JSON.stringify(payload) + String.raw`);
  ['input', 'change', 'keyup'].forEach(function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); });
  await new Promise(function (r) { setTimeout(r, 300); });
  var hit = !!document.querySelector('assay-probe');
  var name = el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('placeholder') || el.tagName.toLowerCase();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
  ['input', 'change'].forEach(function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); });
  return { found: hit, name: String(name).slice(0, 40) };
})()`;

/** Compares two screenshots inside the browser, which already knows how to decode a PNG, so the core needs no image code. */
export const DIFF_SRC = String.raw`(async function (a, b) {
  function load(src) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; }); }
  var A = await load(a), B = await load(b);
  var w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
  function pixels(img) { var c = document.createElement('canvas'); c.width = w; c.height = h; var x = c.getContext('2d'); x.drawImage(img, 0, 0); return { c: c, d: x.getImageData(0, 0, w, h) }; }
  var pa = pixels(A), pb = pixels(B);
  var out = document.createElement('canvas'); out.width = w; out.height = h;
  var ox = out.getContext('2d'), od = ox.createImageData(w, h);
  var changed = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var d = Math.max(Math.abs(pa.d.data[i] - pb.d.data[i]), Math.abs(pa.d.data[i + 1] - pb.d.data[i + 1]), Math.abs(pa.d.data[i + 2] - pb.d.data[i + 2]));
      if (d > 24) {
        changed++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        od.data[i] = 255; od.data[i + 1] = 106; od.data[i + 2] = 0; od.data[i + 3] = 255;
      } else {
        var g = Math.round((pa.d.data[i] * 0.3 + pa.d.data[i + 1] * 0.59 + pa.d.data[i + 2] * 0.11) * 0.35 + 165);
        od.data[i] = g; od.data[i + 1] = g; od.data[i + 2] = g; od.data[i + 3] = 255;
      }
    }
  }
  ox.putImageData(od, 0, 0);
  return { ratio: changed / (w * h), box: changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null, diff: out.toDataURL('image/jpeg', 0.8), base: pa.c.toDataURL('image/jpeg', 0.72), head: pb.c.toDataURL('image/jpeg', 0.72) };
})`;

/**
 * Pseudo-localisation into Arabic (D57): the page's own text is swapped for Arabic letters about 30% longer, the page is mirrored (dir="rtl", lang="ar"),
 * and the page is then measured like any other. Real Arabic letters, so the browser shapes and joins them and falls back to an Arabic font, as a real
 * translation would: what breaks is a box sized for the English words, a line height that clips tall glyphs, a label that no longer fits. It is not a
 * translation and doesn't pretend to be: the same swap is made at the base and at the head, so only what the change added counts. Scripts, styles, code
 * and form fields are left alone, digits and punctuation stay, and the text is not put back (the page is loaded again for the next combination).
 */
export const ARABIC_SRC = String.raw`(function () {
  var d = document.documentElement;
  window.__assayDir = d.getAttribute('dir');
  window.__assayLang = d.getAttribute('lang');
  d.setAttribute('dir', 'rtl');
  d.setAttribute('lang', 'ar');
  var letters = [];
  for (var c = 0x628; c <= 0x63a; c++) letters.push(String.fromCharCode(c));
  for (var e = 0x641; e <= 0x64a; e++) letters.push(String.fromCharCode(e));
  function word(w) {
    var n = Math.ceil(w.length * 1.3), s = '';
    for (var i = 0; i < n; i++) s += letters[(w.charCodeAt(i % w.length) + i * 7) % letters.length];
    return s;
  }
  var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1, SVG: 1, TITLE: 1 };
  var walker = document.createTreeWalker(document.body || d, NodeFilter.SHOW_TEXT);
  var nodes = [], n;
  while ((n = walker.nextNode())) {
    var p = n.parentNode;
    if (p && !skip[String(p.nodeName).toUpperCase()] && /[A-Za-z]/.test(n.nodeValue)) nodes.push(n);
  }
  nodes.forEach(function (t) { t.nodeValue = t.nodeValue.replace(/[A-Za-z]+/g, word); });
  var fields = document.querySelectorAll('input[placeholder], textarea[placeholder]');
  Array.prototype.forEach.call(fields, function (f) { f.setAttribute('placeholder', f.getAttribute('placeholder').replace(/[A-Za-z]+/g, word)); });
  return nodes.length;
})()`;
export const ARABIC_RESTORE_SRC = String.raw`(function () {
  var d = document.documentElement;
  if (window.__assayDir === null) d.removeAttribute('dir'); else d.setAttribute('dir', window.__assayDir);
  if (window.__assayLang === null) d.removeAttribute('lang'); else d.setAttribute('lang', window.__assayLang);
})()`;

/** How fast a page loaded, from the browser's own timings, and how much script it fetched (D62). */
export interface PagePerf {
  /** From the start of navigation to the end of the load event. */
  loadMs?: number;
  /** Largest contentful paint. */
  lcpMs?: number;
  /** Total blocking time: each long task's time over 50 ms, added up. */
  tbtMs?: number;
  /** Cumulative layout shift. */
  cls?: number;
  /** Script fetched, in bytes as sent (a dev build: compare it with the other end, never with production). */
  jsBytes?: number;
  requests?: number;
}

/** Runs before the page's own scripts: keeps what the browser reports about the largest paint, long tasks and layout shifts. */
export const PERF_INIT_SRC = String.raw`(function () {
  var p = (window.__assayPerf = { lcp: 0, tbt: 0, cls: 0 });
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { p.lcp = Math.max(p.lcp, e.startTime); }); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { p.tbt += Math.max(0, e.duration - 50); }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { if (!e.hadRecentInput) p.cls += e.value; }); }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
})()`;

/** After the page settled: its timings, and the script it fetched. */
export const PERF_READ_SRC = String.raw`(function () {
  var n = performance.getEntriesByType('navigation')[0];
  var p = window.__assayPerf || {};
  var r = function (x) { return x > 0 ? Math.round(x) : undefined; };
  var res = performance.getEntriesByType('resource');
  var js = 0;
  res.forEach(function (e) { if (e.initiatorType === 'script' || /\.(m?js|jsx|tsx?|vue|svelte)(\?|$)/.test(e.name)) js += e.encodedBodySize || e.transferSize || 0; });
  return { loadMs: n ? r(n.loadEventEnd || n.duration) : undefined, lcpMs: r(p.lcp), tbtMs: Math.round(p.tbt || 0), cls: Math.round((p.cls || 0) * 1000) / 1000, jsBytes: js || undefined, requests: res.length + 1 };
})()`;
