/* Sample data for the Assay demo. Nothing here was measured; it only shows the shape of the real thing. */

const PROJECT = { name: 'shop-website', branch: 'feature/checkout-redesign', baseline: '5c1e0aa', request: 'Redesign the order summary and apply coupons on the server' };

const COMMITS = [
  { h: 'a41c9e2', m: 'Checkout: order summary card, right-to-left layout', by: 'octocat', when: '2 h ago', files: 6, langs: 'TS · CSS', tests: [214, 214], mut: [74, 74], look: 6.4, calls: 0, a11y: 2, safe: 0, risk: 81, secs: 12, lenses: ['UI'] },
  { h: '7be30d4', m: 'Track checkout start in analytics', by: 'octocat', when: '3 h ago', files: 1, langs: 'TS', tests: [214, 214], mut: [74, 74], look: 0, calls: 0, a11y: 0, safe: 0, risk: 31, secs: 6, lenses: [] },
  { h: 'e5a1c03', m: 'Show coupon errors in the cart', by: 'octocat', when: 'yesterday', files: 2, langs: 'TS', tests: [214, 214], mut: [74, 74], look: 0.8, calls: 0, a11y: 0, safe: 1, risk: 94, secs: 9, lenses: ['Security', 'UI'] },
  { h: '9d03b7f', m: 'API: apply coupons on the server', by: 'octocat', when: 'yesterday', files: 4, langs: 'Python · SQL · TS', tests: [214, 214], mut: [61, 74], look: 0, calls: 1, a11y: 0, safe: 0, risk: 88, secs: 14, lenses: ['Correctness', 'Tests', 'Security'] },
  { h: '3c9f118', m: 'Add coupon-utils to format codes', by: 'octocat', when: '2 days ago', files: 2, langs: 'JSON', tests: [214, 214], mut: [74, 74], look: 0, calls: 0, a11y: 0, safe: 0, risk: 58, secs: 5, lenses: ['Supply'] },
  { h: '5c1e0aa', m: 'Cart: keep quantities after a reload', by: 'octocat', when: '3 days ago', files: 3, langs: 'TS', tests: [214, 214], mut: [74, 74], look: 0, calls: 0, a11y: 0, safe: 0, risk: 12, secs: 8, lenses: [], base: true },
  { h: '2f7d6b9', m: 'Update product images', by: 'octocat', when: '4 days ago', files: 12, langs: 'images', tests: [210, 210], mut: [73, 73], look: 1.1, calls: 0, a11y: 0, safe: 0, risk: 6, secs: 4, lenses: ['UI'] },
  { h: '0ab4e77', m: 'Release 2.3.0', by: 'octocat', when: '5 days ago', files: 2, langs: 'JSON', tests: [210, 210], mut: [73, 73], look: 0, calls: 0, a11y: 0, safe: 0, risk: 4, secs: 4, lenses: [] }
];

const FIX_COMMIT = { h: 'c7d2e18', m: 'Fix: escape coupon errors, keep the empty-cart guard', by: 'agent', when: 'just now', files: 3, langs: 'TS · Python', tests: [216, 216], mut: [70, 74], look: 0, calls: 0, a11y: 0, safe: 0, risk: 24, secs: 11, lenses: ['Security', 'Correctness'], fix: true };

/* Each item is one significant change. "free" ones come from the free checks (no model). "panel" ones need a reviewer. */
const ITEMS = [
  {
    id: 'xss', title: 'Coupon errors are inserted as HTML', lens: 'Security', lensKey: 'Security', commit: 'e5a1c03', lang: 'TS', file: 'web/src/cart/CouponError.tsx', lines: '38–44',
    tier: 'proven', src: 'free', sev: 'high', risk: 94, ref: 'CWE-79', memory: ['M-001'], needs: null, flaggedBy: ['Security'], fixable: true,
    why: ['A probe ran in a real page', 'Matches a known mistake (M-001)', 'Touches user input'],
    observed: ['Typing <code>"&gt;&lt;assay-probe data-xss&gt;</code> into the coupon box put that element on <code>/cart</code>.', 'The server repeats the typed code inside its error text.'],
    inferred: ['A crafted coupon link could run script in a shopper’s session, if something can prefill the box.'],
    intent: { verdict: 'unintended', text: 'The request says nothing about rendering errors as HTML.' },
    diff: { file: 'web/src/cart/CouponError.tsx', head: '@@ -38,7 +38,7 @@ export function CouponError({ error }: Props)', rows: [
      [' ', 38, 38, '  if (!error) return null;'], [' ', 39, 39, ''], [' ', 40, 40, '  return ('],
      ['-', 41, '', '    <p className="coupon-error">{error}</p>'],
      ['+', '', 41, '    <p className="coupon-error" dangerouslySetInnerHTML={{ __html: error }} />', 1],
      [' ', 42, 42, '  );'], [' ', 43, 43, '}']] },
    evidence: [
      { id: 'ev-1', kind: 'Headless browser probe', what: 'A probe element typed into the coupon box appeared in the page after the answer came back.', who: 'Free check · attack', cmd: 'assay replay ev-1' },
      { id: 'ev-2', kind: 'Static rule', what: 'dangerouslySetInnerHTML receives a value that came from the network.', who: 'Free check · Semgrep rule', cmd: 'assay replay ev-2' }],
    out: 'probe'
  },
  {
    id: 'crash', title: 'An empty cart now crashes the coupon endpoint', lens: 'Correctness', lensKey: 'Correctness', commit: '9d03b7f', lang: 'PY', file: 'api/cart.py', lines: '82–87',
    tier: 'proven', src: 'free', sev: 'high', risk: 88, ref: 'CWE-129', memory: ['M-017'], needs: null, flaggedBy: ['Correctness', 'Tests'], fixable: true,
    why: ['Behaviour changed on a real call', 'No test fails if this hunk is reverted', 'Matches a known mistake (M-017)'],
    observed: ['<code>POST /api/cart/coupon</code> on an empty cart answered <b>500</b>. Before this range it answered <b>400</b> “cart is empty”.', 'The Cart and Checkout pages call this endpoint (2 pages, from the recorded activity).'],
    inferred: ['A shopper who removes the last item and then applies a code sees a broken page.'],
    intent: { verdict: 'unintended', text: 'The request says “apply coupons on the server”. Nothing says an empty cart should fail with a 500.' },
    diff: { file: 'api/cart.py', head: '@@ -82,6 +82,5 @@ def apply_coupon(cart, code):', rows: [
      [' ', 82, 82, 'def apply_coupon(cart, code):'],
      ['-', 83, '', '    if not cart.items:'],
      ['-', 84, '', '        raise BadRequest("cart is empty")'],
      ['+', '', 83, '    first = cart.items[0]', 1],
      [' ', 85, 84, '    rule = COUPONS.get(code)'], [' ', 86, 85, '    if rule is None:'],
      [' ', 87, 86, '        raise BadRequest(f"Coupon {code} is not valid")']] },
    evidence: [
      { id: 'ev-3', kind: 'Behaviour diff', what: 'The same request on 5c1e0aa and on 9d03b7f gave different answers (400 against 500).', who: 'Free check · behaviour diff', cmd: 'assay replay ev-3' },
      { id: 'ev-4', kind: 'Server log', what: 'IndexError: list index out of range at api/cart.py:83', who: 'Free check · run log', cmd: 'assay replay ev-4' },
      { id: 'ev-5', kind: 'Revert test', what: 'Reverting this hunk fails no test: all 214 still pass.', who: 'Free check · counterfactual', cmd: 'assay replay ev-5' }],
    out: 'crash'
  },
  {
    id: 'rtl', title: 'Order summary breaks in Arabic (right to left)', lens: 'UI', lensKey: 'UI', commit: 'a41c9e2', lang: 'CSS', file: 'web/src/checkout/summary.css', lines: '12–22',
    tier: 'proven', src: 'free', sev: 'medium', risk: 81, ref: 'Measured', memory: ['M-021', 'M-022'], needs: null, flaggedBy: ['UI & accessibility'], fixable: false,
    why: ['Measured in a real render', 'Physical <code>right</code> instead of a logical property', 'Fixed width on a text button'],
    observed: [], inferred: ['Arabic shoppers on phones may not be able to read the order button. This looks like <code>right</code> used where <code>inset-inline-end</code> belongs.'],
    intent: { verdict: 'unintended', text: 'The redesign is intended. Breaking the mirrored layout is not.' },
    diff: { file: 'web/src/checkout/summary.css', head: '@@ -12,11 +12,12 @@', rows: [
      [' ', 12, 12, '.price-badge {'], [' ', 13, 13, '  position: absolute;'], [' ', 14, 14, '  top: 12px;'],
      ['-', 15, '', '  inset-inline-end: 12px;'],
      ['+', '', 15, '  right: 12px;', 1],
      [' ', 16, 16, '}'], [' ', 17, 17, ''], [' ', 18, 18, '.place-order {'],
      ['+', '', 19, '  width: 148px;', 1], ['+', '', 20, '  white-space: nowrap;', 1],
      [' ', 21, 21, '  min-height: 44px;'], [' ', 22, 22, '}']] },
    evidence: [
      { id: 'ev-6', kind: 'Measured render', what: 'The price badge’s box overlaps the product image’s box in every Arabic combination.', who: 'Free check · render matrix', cmd: 'assay replay ev-6' },
      { id: 'ev-7', kind: 'Measured render', what: 'The order button’s text is wider than its box (scrollWidth over clientWidth) in Arabic.', who: 'Free check · render matrix', cmd: 'assay replay ev-7' }],
    out: 'rtl', ui: true, combo: { loc: 'ar', theme: 'light', vp: 'mobile' }, kinds: ['overlap', 'clip']
  },
  {
    id: 'mut', title: 'Discount math isn’t pinned down by the tests', lens: 'Tests', lensKey: 'Tests', commit: '9d03b7f', lang: 'PY', file: 'api/discount.py', lines: '12–15',
    tier: 'proven', src: 'free', sev: 'low', risk: 63, ref: 'Mutation', memory: ['M-018'], needs: null, flaggedBy: ['Tests'], fixable: false,
    why: ['Mutation score fell 13 points', 'New logic, tests that don’t notice changes'],
    observed: ['23 small deliberate changes were made to the new code. The tests still passed for <b>9</b> of them (score 61%, was 74%).', 'Reverting the empty-cart guard fails no test.'],
    inferred: ['A wrong discount (÷ 100 turned into × 100) could ship without any test noticing.'],
    intent: { verdict: 'n/a', text: '' },
    diff: { file: 'api/discount.py', head: '@@ -0,0 +12,4 @@', rows: [
      ['+', '', 12, 'def apply_discount(total, rule):'], ['+', '', 13, '    if rule.kind == "percent":'],
      ['+', '', 14, '        return total - total * rule.value / 100', 1],
      ['+', '', 15, '    return max(total - rule.value, 0)', 1]] },
    evidence: [
      { id: 'ev-8', kind: 'Mutation run', what: '23 mutants in 3 changed functions: 14 killed, 9 survived.', who: 'Free check · mutation (changed lines only)', cmd: 'assay replay ev-8' }],
    out: 'mut'
  },
  {
    id: 'dep', title: 'New dependency looks risky: coupon-utils', lens: 'Supply chain', lensKey: 'Supply', commit: '3c9f118', lang: 'JSON', file: 'package.json', lines: '24',
    tier: 'corroborated', src: 'panel', sev: 'medium', risk: 58, ref: 'Registry', memory: ['M-030'], needs: 'sup', flaggedBy: ['Supply chain'], fixable: false,
    why: ['Four independent signals agree', 'New dependency, new install script'],
    observed: ['Published 3 days ago by 1 maintainer, 41 downloads last week.', 'It has an install script that runs on <code>npm install</code>.', 'Its name is one letter from <code>coupon-util</code>, which this project doesn’t use.'],
    inferred: ['Could be a look-alike package. No single signal proves it.'],
    intent: { verdict: 'n/a', text: '' },
    diff: { file: 'package.json', head: '@@ -22,6 +22,7 @@ "dependencies": {', rows: [
      [' ', 22, 22, '    "react": "^19.0.0",'], [' ', 23, 23, '    "react-dom": "^19.0.0",'],
      ['+', '', 24, '    "coupon-utils": "^0.3.1",', 1], [' ', 24, 25, '    "zod": "^3.24.0"']] },
    evidence: [
      { id: 'ev-9', kind: 'Registry', what: 'Package age 3 days; 1 maintainer; 41 weekly downloads.', who: 'Free check · registry lookup', cmd: 'assay replay ev-9' },
      { id: 'ev-10', kind: 'Install script', what: 'A postinstall script runs a network request.', who: 'Free check · package scan', cmd: 'assay replay ev-10' },
      { id: 'ev-11', kind: 'Name check', what: 'Edit distance 1 from coupon-util.', who: 'Free check · name distance', cmd: 'assay replay ev-11' },
      { id: 'ev-12', kind: 'Reviewer', what: 'Supply chain reviewer: nothing in the code needs a package this new.', who: 'Reviewer · Supply chain', cmd: 'assay replay ev-12' }],
    out: 'dep'
  },
  {
    id: 'contrast', title: 'Muted text fails contrast in the dark theme', lens: 'UI', lensKey: 'UI', commit: 'a41c9e2', lang: 'CSS', file: 'web/src/checkout/summary.css', lines: '33–36',
    tier: 'proven', src: 'free', sev: 'medium', risk: 55, ref: 'WCAG 1.4.3', memory: ['M-009'], needs: null, flaggedBy: ['UI & accessibility'], fixable: false,
    why: ['Measured with the page’s real colours', 'Fails a stated standard (WCAG 1.4.3)'],
    observed: [], inferred: ['People with low vision won’t read the shipping line in the dark theme.'],
    intent: { verdict: 'unintended', text: 'No colour change was asked for.' },
    diff: { file: 'web/src/checkout/summary.css', head: '@@ -33,4 +33,7 @@', rows: [
      [' ', 33, 33, '.muted {'], ['-', 34, '', '  color: var(--text-dim);'], ['+', '', 34, '  color: var(--muted);'],
      ['+', '', 35, '}'], ['+', '', 36, '[data-theme="dark"] .muted {'], ['+', '', 37, '  color: #6e6895;', 1], ['+', '', 38, '}']] },
    evidence: [
      { id: 'ev-13', kind: 'Measured colours', what: 'The “Free shipping” text against its background, read from the rendered page.', who: 'Free check · accessibility audit', cmd: 'assay replay ev-13' }],
    out: 'contrast', ui: true, combo: { loc: 'en', theme: 'dark', vp: 'mobile' }, kinds: ['contrast']
  },
  {
    id: 'scope', title: 'Unrequested change: analytics tracking', lens: 'Scope', lensKey: 'Scope', commit: '7be30d4', lang: 'TS', file: 'web/src/analytics/track.ts', lines: '9–14',
    tier: 'corroborated', src: 'panel', sev: 'low', risk: 31, ref: 'Scope', memory: [], needs: 'tri', flaggedBy: ['Triage'], fixable: false,
    why: ['Not traceable to the request', 'Touches a system nobody mentioned'],
    observed: ['The request names two things: the order summary and server-side coupons. This commit adds an event to a third system.', '1 of 15 changed files can’t be traced to the request.'],
    inferred: ['It may well be wanted. Someone should say so.'],
    intent: { verdict: 'unknown', text: 'The request text doesn’t mention analytics.' },
    diff: { file: 'web/src/analytics/track.ts', head: '@@ -9,5 +9,6 @@ export function startCheckout(cartId: string)', rows: [
      [' ', 9, 9, 'export function startCheckout(cartId: string) {'], [' ', 10, 10, '  openCheckout(cartId);'],
      ['+', '', 11, '  track("checkout_started", { cartId });', 1], [' ', 11, 12, '}']] },
    evidence: [
      { id: 'ev-14', kind: 'Request trace', what: 'Matched each changed file to the two things the request names; one file matched neither.', who: 'Triage', cmd: 'assay replay ev-14' }],
    out: 'scope'
  },
  {
    id: 'round', title: 'Possible rounding error in the order total', lens: 'Correctness', lensKey: 'Correctness', commit: '9d03b7f', lang: 'PY', file: 'api/cart.py', lines: '97–101',
    tier: 'hint', src: 'panel', sev: 'low', risk: 22, ref: 'CWE-682', memory: ['M-014'], needs: 'cor', flaggedBy: ['Correctness'], fixable: false, provable: true,
    why: ['One reviewer’s reading', 'No run shows it going wrong'],
    observed: ['A reviewer read <code>total * 0.9</code> on a float and suspects off-by-one-cent totals.', 'No test, run or trace shows it going wrong.'],
    inferred: ['Money as floats can drift. Often harmless when totals are rounded for display.'],
    intent: { verdict: 'n/a', text: '' },
    diff: { file: 'api/cart.py', head: '@@ -97,5 +97,5 @@ def cart_total(cart, rule):', rows: [
      [' ', 97, 97, 'def cart_total(cart, rule):'], [' ', 98, 98, '    total = sum(i.price * i.qty for i in cart.items)'],
      ['+', '', 99, '    total = total * 0.9 if rule else total', 1], [' ', 99, 100, '    return round(total, 2)']] },
    evidence: [{ id: 'ev-15', kind: 'Reviewer claim', what: 'Correctness reviewer: float arithmetic on money.', who: 'Reviewer · Correctness (no evidence yet)', cmd: 'assay prove claim-15' }],
    out: 'round'
  }
];

const REVIEWERS = [
  { id: 'sec', name: 'Security', lens: 'Security', tokens: 4800, why: 'Touches an error message, an API route and user input.', skip: 'No input, auth or route changed.' },
  { id: 'cor', name: 'Correctness', lens: 'Correctness', tokens: 4100, why: 'Behaviour changed on a real call.', skip: 'No behaviour change observed.' },
  { id: 'ui', name: 'UI & accessibility', lens: 'UI', tokens: 3400, why: 'Layout and colour changed; the render differs.', skip: 'The pages look the same.' },
  { id: 'tst', name: 'Tests', lens: 'Tests', tokens: 2600, why: 'The mutation score fell.', skip: 'The mutation score didn’t move.' },
  { id: 'sup', name: 'Supply chain', lens: 'Supply', tokens: 2200, why: 'A dependency list changed.', skip: 'No dependency list changed.' },
  { id: 'perf', name: 'Performance', lens: 'Perf', tokens: 3000, why: 'A loop, query or render path changed.', skip: 'No loop, query or render path changed.' }
];
const TRIAGE_TOKENS = 1400, CROSS_TOKENS = 2100, ADV_TOKENS = 8500;

const DROPPED = [
  { claim: 'Possible N+1 query when loading the cart', why: 'The query log shows 3 queries for the page. Nothing repeats.' },
  { claim: 'Variable name tmp2 is unclear', why: 'A style opinion, no standard or check backs it.' },
  { claim: 'Memoize the summary card for speed', why: 'No profile shows it being slow.' }
];

const MEMORY = [
  { id: 'M-001', name: 'Untrusted text inserted as HTML', kind: 'standard', ref: 'CWE-79', det: 'Semgrep rule + browser probe', langs: 'TS · JS', hits: 7, fp: 1, last: 'today', weeks: [0, 1, 0, 2, 0, 0, 1, 0, 1, 0, 1, 1], bad: 'el.innerHTML = message', good: 'el.textContent = message', from: 'Standard pack · 3 of the 7 hits were mistakes in this repo, first fixed in 8d2b0f4.' },
  { id: 'M-017', name: 'Guard removed before indexing a list', kind: 'learned', ref: 'CWE-129', det: 'Test template (empty input)', langs: 'PY · TS', hits: 3, fp: 0, last: 'today', weeks: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1], bad: 'first = items[0]', good: 'if not items: raise BadRequest(…)', from: 'Learned here · 2 fix commits (e.g. 91c4d20 “fix: empty cart crashed the totals”).' },
  { id: 'M-021', name: 'Physical CSS side (left/right) where the layout must mirror', kind: 'learned', ref: 'Own rule', det: 'Semgrep rule + render matrix', langs: 'CSS', hits: 5, fp: 1, last: 'today', weeks: [1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1], bad: 'right: 12px', good: 'inset-inline-end: 12px', from: 'Learned here · 4 fix commits (e.g. 6e07a1c “fix: badge flipped in Arabic”).' },
  { id: 'M-022', name: 'Fixed width on a button that holds text', kind: 'learned', ref: 'Own rule', det: 'Render matrix (text wider than box)', langs: 'CSS', hits: 4, fp: 0, last: 'today', weeks: [0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1], bad: 'width: 148px', good: 'min-width: 148px', from: 'Learned here · 3 fix commits.' },
  { id: 'M-009', name: 'Muted text under 4.5:1', kind: 'standard', ref: 'WCAG 1.4.3', det: 'Accessibility audit on the render', langs: 'CSS', hits: 9, fp: 0, last: 'today', weeks: [1, 1, 0, 1, 0, 2, 0, 1, 1, 0, 1, 1], bad: 'color: #6e6895 on #181529', good: 'color: #b0adc9 on #181529', from: 'Standard pack · WCAG 2.2 AA.' },
  { id: 'M-018', name: 'New logic that no test fails on', kind: 'standard', ref: 'Mutation gate', det: 'Mutation run on changed lines', langs: 'Any', hits: 6, fp: 1, last: 'today', weeks: [0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1], bad: 'tests pass with the line flipped', good: 'a test pins the value', from: 'Standard pack · QA gate (yours, v2).' },
  { id: 'M-030', name: 'New dependency: young, tiny, with an install script', kind: 'standard', ref: 'Registry hygiene', det: 'Registry lookup + package scan', langs: 'JSON', hits: 2, fp: 0, last: 'today', weeks: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1], bad: '"coupon-utils": "^0.3.1"', good: 'a known, older package', from: 'Standard pack · SLSA and registry hygiene.' },
  { id: 'M-014', name: 'Float arithmetic on money', kind: 'learned', ref: 'CWE-682', det: 'Reviewer checklist (no machine check)', langs: 'PY · TS', hits: 9, fp: 4, last: '41 days ago', weeks: [1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0], bad: 'total * 0.9', good: 'Decimal(total) * Decimal("0.9")', from: 'Learned here · 2 real bugs, 4 dismissed as harmless. Expires at 60 quiet days.' },
  { id: 'M-005', name: 'SQL built by string concatenation', kind: 'standard', ref: 'CWE-89', det: 'Semgrep rule', langs: 'PY · JS · Go', hits: 3, fp: 0, last: '5 weeks ago', weeks: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0], bad: 'f"… WHERE id = {id}"', good: 'cursor.execute("… WHERE id = %s", (id,))', from: 'Standard pack · CWE Top 25.' },
  { id: 'M-040', name: 'Test assertion weakened until it passes', kind: 'learned', ref: 'Own rule', det: 'Diff rule + mutation run', langs: 'Any', hits: 2, fp: 0, last: '3 weeks ago', weeks: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], bad: 'assert x == y  →  assert True', good: 'keep the real assertion', from: 'Learned here · 2 fix commits.' }
];
const MINED = [
  { id: 'M-051', name: 'Date parsed without a time zone', kind: 'learned', ref: 'Own rule', det: 'Semgrep rule (suggested)', langs: 'TS · PY', hits: 0, fp: 0, last: 'never', weeks: [0,0,0,0,0,0,0,0,0,0,0,0], bad: 'new Date(str)', good: 'parse with an explicit zone', from: 'Mined · 5 fix commits touch date parsing (e.g. c0d41e8).' },
  { id: 'M-052', name: 'Fetch without a timeout', kind: 'learned', ref: 'Own rule', det: 'Semgrep rule (suggested)', langs: 'TS', hits: 0, fp: 0, last: 'never', weeks: [0,0,0,0,0,0,0,0,0,0,0,0], bad: 'await fetch(url)', good: 'fetch(url, { signal: AbortSignal.timeout(5000) })', from: 'Mined · 3 fix commits add timeouts after hangs.' },
  { id: 'M-053', name: 'Migration drops a column in the same release', kind: 'learned', ref: 'Own rule', det: 'SQL diff rule (suggested)', langs: 'SQL', hits: 0, fp: 0, last: 'never', weeks: [0,0,0,0,0,0,0,0,0,0,0,0], bad: 'ALTER TABLE … DROP COLUMN', good: 'expand, migrate, contract', from: 'Mined · 2 fix commits restore a dropped column.' }
];

const PACKS = [
  { id: 'agentic', name: 'OWASP Top 10 for Agentic Applications', ver: 'Dec 2025', rules: 10, auto: 4, on: true, note: 'For agents, MCP servers and skills.' },
  { id: 'web', name: 'OWASP Top 10 (web)', ver: 'edition not pinned', rules: 10, auto: 6, on: false, warn: 'Pick the current edition when you import it.' },
  { id: 'cwe', name: 'CWE Top 25', ver: 'edition not pinned', rules: 25, auto: 14, on: true, warn: 'Pick the current edition when you import it.' },
  { id: 'wcag', name: 'WCAG 2.2 AA', ver: '2.2', rules: 34, auto: 21, on: true, note: 'Contrast, names, focus, target size, reflow.' },
  { id: 'slsa', name: 'SLSA and registry hygiene', ver: '1.x', rules: 12, auto: 9, on: true, note: 'Age, maintainers, install scripts, look-alike names.' },
  { id: 'senior', name: 'Senior review checklist', ver: 'yours · v3', rules: 28, auto: 11, on: true, note: 'Your own rules, one per line.' },
  { id: 'qa', name: 'QA: test pyramid and mutation gate', ver: 'yours · v2', rules: 16, auto: 12, on: true, note: 'Where tests belong and what score blocks a merge.' }
];

const PROVIDERS = [
  { name: 'Dev dashboard', gives: 'Run any commit, visual and behaviour diff, attack check, activity history, headless browser', state: 'found', how: 'found, 52 tools' },
  { name: 'Semgrep', gives: 'Static rules in 30+ languages', state: 'found', how: 'on PATH' },
  { name: 'gitleaks', gives: 'Secrets in files and history', state: 'found', how: 'on PATH' },
  { name: 'osv-scanner', gives: 'Known vulnerabilities in lock files', state: 'missing', how: 'optional' },
  { name: 'Snyk agent-scan', gives: 'Audit MCP servers and skills', state: 'missing', how: 'optional' },
  { name: 'Stryker', gives: 'Mutation testing for JS and TS', state: 'found', how: 'in devDependencies' },
  { name: 'mutmut', gives: 'Mutation testing for Python', state: 'missing', how: 'optional' }
];

const LANG_COLS = ['Run tests', 'Split into functions', 'Static scan', 'Mutation', 'Function before / after', 'Coverage'];
const LANGS = [
  ['TypeScript / JavaScript', 'b', 'b', 'b', 'b', 'b', 'b'],
  ['Python', 'b', 'b', 'b', 'b', 'b', 'b'],
  ['Go', 'b', 'b', 'b', 'a', 'a', 'b'],
  ['Java / Kotlin', 'a', 'b', 'b', 'a', 'a', 'a'],
  ['Rust', 'a', 'b', 'b', 'a', 'a', 'a'],
  ['C#', 'a', 'b', 'b', 'a', 'n', 'a'],
  ['PHP / Ruby', 'a', 'b', 'b', 'n', 'n', 'n'],
  ['Any other language', 'a', 'a', 'a', 'n', 'n', 'n']
];

/* Calibration: bugs planted in a throwaway copy, and what each reviewer did. C caught with proof, h flagged without proof, m missed, - not its lens. */
const CAL_ROWS = [
  { id: 'chk', name: 'Free checks (no model)', tokens: 0, alarms: 0 },
  { id: 'sec', name: 'Security', tokens: 4800, alarms: 1 },
  { id: 'cor', name: 'Correctness', tokens: 4100, alarms: 3 },
  { id: 'tst', name: 'Tests', tokens: 2600, alarms: 0 },
  { id: 'ui', name: 'UI & accessibility', tokens: 3400, alarms: 0 },
  { id: 'sup', name: 'Supply chain', tokens: 2200, alarms: 1 },
  { id: 'perf', name: 'Performance', tokens: 3000, alarms: 2 },
  { id: 'plain', name: 'One plain AI review (no gate)', tokens: 9500, alarms: 7, plain: true }
];
const CAL_BUGS = [
  ['Off-by-one in pagination', 'm-Ch---h'],
  ['Auth check removed from a route', 'mCh----m'],
  ['Unescaped output in a template', 'CC-----h'],
  ['Arguments swapped in a discount call', 'm-CC---h'],
  ['Null check removed before .length', 'm-mh---m'],
  ['SQL built by string concatenation', 'CC-----h'],
  ['Secret hard-coded in config', 'CC-----h'],
  ['aria-label removed from an icon button', 'C---C--m'],
  ['left/right used in a mirrored layout', 'C---C--m'],
  ['Test assertion weakened to always pass', 'C--C---m'],
  ['Look-alike dependency added', 'hh---C-m'],
  ['N+1 query added in a loop', 'C-h---Cm']
];

const STR = {
  en: { title: 'Order summary', qty: 'Qty', items: [{ n: 'Canvas tote bag', q: 1, p: '$24.00' }, { n: 'Ceramic mug set', q: 2, p: '$36.00' }], sub: 'Subtotal', subv: '$60.00', ship: 'Free shipping', shipv: '$0.00', coupon: 'Coupon SAVE10', couponv: '−$6.00', total: 'Total', totalv: '$54.00', order: 'Place order' },
  ar: { title: 'ملخص الطلب', qty: 'الكمية', items: [{ n: 'حقيبة قماشية', q: '١', p: '٢٤٫٠٠ $' }, { n: 'طقم أكواب خزفية', q: '٢', p: '٣٦٫٠٠ $' }], sub: 'المجموع الفرعي', subv: '٦٠٫٠٠ $', ship: 'شحن مجاني', shipv: '٠٫٠٠ $', coupon: 'قسيمة SAVE10', couponv: '−٦٫٠٠ $', total: 'الإجمالي', totalv: '٥٤٫٠٠ $', order: 'تأكيد الطلب وإتمام الدفع' }
};

const SYMPTOMS = [
  { id: 'crash', label: 'POST /api/cart/coupon answers 500 on an empty cart', firstBad: '9d03b7f' },
  { id: 'xss', label: 'A coupon code is inserted as HTML on /cart', firstBad: 'e5a1c03' },
  { id: 'rtl', label: 'The order summary overlaps itself in Arabic', firstBad: 'a41c9e2' }
];
