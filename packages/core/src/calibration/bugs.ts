import type { Lens } from '../types.js';

/**
 * The bugs calibration plants (D44). Each one has a clean twin: the same code written correctly. The planted version goes in one commit and the
 * clean twin in another, so a reviewer's catches and its false alarms are measured on the same kind of code. Files get ordinary names: a
 * name like "planted_bug.js" would tell the reviewer where to look.
 *
 * A template is written in one language family. Calibration plants the ones that fit the project it is run in.
 */
export type Family = 'js' | 'py' | 'css' | 'html' | 'manifest';

export interface BugTemplate {
  id: string;
  name: string;
  lens: Lens;
  family: Family;
  /** The file's name, in a folder the project already uses for that language. */
  file: string;
  /** A test file: it goes under tests/. */
  test?: boolean;
  /** What the file holds in the base commit, for a bug that is an edit (a removed guard). Without it the bug is a new file. */
  base?: string;
  /** The file with the bug in it. */
  bad: string;
  /** The same change, written correctly. */
  good: string;
  /** A piece of text on the buggy line. The truth is that line: in `bad` for an added line, in `base` for a removed one. */
  mark: string;
  side: 'added' | 'removed';
}

const guardJs = `export function firstName(user) {
  if (!user) {
    throw new Error('A user is required');
  }
  return user.name.split(' ')[0];
}
`;
const guardPy = `def first_name(user):
    if user is None:
        raise ValueError("A user is required")
    return user["name"].split(" ")[0]
`;
const testJs = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sumPrices } from '../price_totals.js';

test('sums the prices', () => {
  assert.equal(sumPrices([{ price: 20 }, { price: 40 }]), 60);
});
`;
const testPy = `from price_totals import sum_prices


def test_sums_the_prices():
    assert sum_prices([{"price": 20}, {"price": 40}]) == 60
`;
const themeCss = `.card {
  margin-inline-start: 8px;
}

.badge {
  position: absolute;
  top: 12px;
  inset-inline-end: 12px;
}
`;

export const TEMPLATES: BugTemplate[] = [
  // JavaScript and TypeScript
  { id: 'html-sink', name: 'Comment text inserted as HTML', lens: 'Security', family: 'js', file: 'comment_list.js', mark: 'row.innerHTML = comment.text', side: 'added',
    bad: `export function renderComments(container, comments) {\n  container.replaceChildren();\n  for (const comment of comments) {\n    const row = document.createElement('li');\n    row.innerHTML = comment.text;\n    container.appendChild(row);\n  }\n}\n`,
    good: `export function renderComments(container, comments) {\n  container.replaceChildren();\n  for (const comment of comments) {\n    const row = document.createElement('li');\n    row.textContent = comment.text;\n    container.appendChild(row);\n  }\n}\n` },
  { id: 'hardcoded-key', name: 'API key written into the code', lens: 'Security', family: 'js', file: 'payment_client.js', mark: 'const API_KEY', side: 'added',
    bad: `const API_KEY = "AKIAJ3Q7ZB4XK2W9R5TM";\n\nexport function authHeader() {\n  return { Authorization: \`Bearer \${API_KEY}\` };\n}\n`,
    good: `const API_KEY = process.env.PAYMENT_API_KEY;\n\nexport function authHeader() {\n  return { Authorization: \`Bearer \${API_KEY}\` };\n}\n` },
  { id: 'sql-concat', name: 'Database query built from a user id', lens: 'Security', family: 'js', file: 'order_store.js', mark: 'SELECT * FROM orders', side: 'added',
    bad: `export function ordersFor(db, userId) {\n  return db.query("SELECT * FROM orders WHERE user_id = " + userId);\n}\n`,
    good: `export function ordersFor(db, userId) {\n  return db.query("SELECT * FROM orders WHERE user_id = ?", [userId]);\n}\n` },
  { id: 'off-by-one', name: 'Loop runs one step past the end', lens: 'Correctness', family: 'js', file: 'price_totals.js', mark: 'i <= items.length', side: 'added',
    bad: `export function sumPrices(items) {\n  let total = 0;\n  for (let i = 0; i <= items.length; i++) {\n    total += items[i].price;\n  }\n  return total;\n}\n`,
    good: `export function sumPrices(items) {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) {\n    total += items[i].price;\n  }\n  return total;\n}\n` },
  { id: 'swapped-args', name: 'Arguments swapped in a discount call', lens: 'Correctness', family: 'js', file: 'discounts.js', mark: 'applyDiscount(rate, price)', side: 'added',
    bad: `export function applyDiscount(price, rate) {\n  return price - price * rate;\n}\n\nexport function checkoutTotal(price, rate) {\n  return applyDiscount(rate, price);\n}\n`,
    good: `export function applyDiscount(price, rate) {\n  return price - price * rate;\n}\n\nexport function checkoutTotal(price, rate) {\n  return applyDiscount(price, rate);\n}\n` },
  { id: 'removed-guard', name: 'A check on the user was removed', lens: 'Correctness', family: 'js', file: 'user_names.js', mark: 'if (!user)', side: 'removed', base: guardJs,
    bad: `export function firstName(user) {\n  return user.name.split(' ')[0];\n}\n`,
    good: `${guardJs}\nexport function lastName(user) {\n  if (!user) {\n    throw new Error('A user is required');\n  }\n  return user.name.split(' ').slice(-1)[0];\n}\n` },
  { id: 'weak-assertion', name: 'A test assertion changed to always pass', lens: 'Tests', family: 'js', file: 'price_totals.test.js', test: true, mark: 'assert.ok(true)', side: 'added', base: testJs,
    bad: testJs.replace('assert.equal(sumPrices([{ price: 20 }, { price: 40 }]), 60);', 'assert.ok(true);'),
    good: `${testJs}\ntest('sums nothing to zero', () => {\n  assert.equal(sumPrices([]), 0);\n});\n` },
  { id: 'n-plus-one', name: 'A query for every id in a loop', lens: 'Performance', family: 'js', file: 'item_loader.js', mark: 'await db.query', side: 'added',
    bad: `export async function loadItems(db, ids) {\n  const items = [];\n  for (const id of ids) {\n    items.push(await db.query('SELECT * FROM items WHERE id = ?', [id]));\n  }\n  return items;\n}\n`,
    good: `export async function loadItems(db, ids) {\n  return db.query('SELECT * FROM items WHERE id IN (?)', [ids]);\n}\n` },
  // the manifest: made from the project's own package.json
  { id: 'lookalike-dependency', name: 'A dependency named like a popular one', lens: 'Supply chain', family: 'manifest', file: 'package.json', mark: '"reactt"', side: 'added', bad: '', good: '' },
  // CSS
  { id: 'physical-side', name: 'right used where the layout must mirror', lens: 'UI', family: 'css', file: 'theme.css', mark: 'right: 12px', side: 'added', base: themeCss,
    bad: themeCss.replace('inset-inline-end: 12px;', 'right: 12px;'),
    good: `${themeCss}\n.badge-muted {\n  opacity: 0.7;\n}\n` },
  { id: 'fixed-width', name: 'Fixed width on a button that holds text', lens: 'UI', family: 'css', file: 'pay_button.css', mark: 'width: 148px', side: 'added',
    bad: `.pay-button {\n  width: 148px;\n  overflow: hidden;\n  white-space: nowrap;\n}\n`,
    good: `.pay-button {\n  min-width: 148px;\n}\n` },
  { id: 'faint-text', name: 'Hint text too faint to read', lens: 'UI', family: 'css', file: 'hints.css', mark: 'color: #c9c7e4', side: 'added',
    bad: `.hint {\n  color: #c9c7e4;\n  background: #ffffff;\n}\n`,
    good: `.hint {\n  color: #5b5878;\n  background: #ffffff;\n}\n` },
  // HTML
  { id: 'no-alt', name: 'An image with no alt text', lens: 'UI', family: 'html', file: 'logo_header.html', mark: '<img src="logo.png"', side: 'added',
    bad: `<header>\n  <img src="logo.png" class="logo">\n</header>\n`,
    good: `<header>\n  <img src="logo.png" class="logo" alt="Shop logo">\n</header>\n` },
  // Python
  { id: 'sql-concat-py', name: 'Database query built from a user id', lens: 'Security', family: 'py', file: 'order_store.py', mark: 'SELECT * FROM orders', side: 'added',
    bad: `def orders_for(cursor, user_id):\n    cursor.execute("SELECT * FROM orders WHERE user_id = " + user_id)\n    return cursor.fetchall()\n`,
    good: `def orders_for(cursor, user_id):\n    cursor.execute("SELECT * FROM orders WHERE user_id = %s", (user_id,))\n    return cursor.fetchall()\n` },
  { id: 'shell-py', name: 'A file name passed to a shell command', lens: 'Security', family: 'py', file: 'thumbnail.py', mark: 'os.system', side: 'added',
    bad: `import os\n\n\ndef make_thumbnail(filename):\n    os.system("convert " + filename + " out.png")\n`,
    good: `import subprocess\n\n\ndef make_thumbnail(filename):\n    subprocess.run(["convert", filename, "out.png"], check=True)\n` },
  { id: 'off-by-one-py', name: 'Loop runs one step past the end', lens: 'Correctness', family: 'py', file: 'price_totals.py', mark: 'len(items) + 1', side: 'added',
    bad: `def sum_prices(items):\n    total = 0\n    for i in range(len(items) + 1):\n        total += items[i]["price"]\n    return total\n`,
    good: `def sum_prices(items):\n    total = 0\n    for i in range(len(items)):\n        total += items[i]["price"]\n    return total\n` },
  { id: 'removed-guard-py', name: 'A check on the user was removed', lens: 'Correctness', family: 'py', file: 'user_names.py', mark: 'if user is None', side: 'removed', base: guardPy,
    bad: `def first_name(user):\n    return user["name"].split(" ")[0]\n`,
    good: `${guardPy}\n\ndef last_name(user):\n    if user is None:\n        raise ValueError("A user is required")\n    return user["name"].split(" ")[-1]\n` },
  { id: 'weak-assertion-py', name: 'A test assertion changed to always pass', lens: 'Tests', family: 'py', file: 'test_price_totals.py', test: true, mark: 'assert True', side: 'added', base: testPy,
    bad: testPy.replace('assert sum_prices([{"price": 20}, {"price": 40}]) == 60', 'assert True'),
    good: `${testPy}\n\ndef test_sums_nothing_to_zero():\n    assert sum_prices([]) == 0\n` }
];

/** Which line of `text` holds `mark` (1-based), or 0. */
export const lineOf = (text: string, mark: string): number => {
  const i = text.split('\n').findIndex(l => l.includes(mark));
  return i === -1 ? 0 : i + 1;
};
