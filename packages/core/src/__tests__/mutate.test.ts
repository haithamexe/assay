import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileDiff } from '../diff.js';
import { codeLines, mutantsFor, pickMutants } from '../proof/mutate.js';

/* Language-aware mutation (D56): the right operators for each language, and never a comment or the inside of a string. */

const diff = (path: string, rows: string[]): FileDiff => ({
  path, oldPath: null, status: 'added', binary: false, additions: rows.length, deletions: 0, truncated: false,
  hunks: [{ header: '@@', oldStart: 0, oldLines: 0, newStart: 1, newLines: rows.length, lines: rows.map((text, i) => ({ t: '+' as const, o: null, n: i + 1, text })) }]
});
/** What the mutants of every added line of a file would change, as "line:op" and the line as it would read. */
const mutate = (path: string, rows: string[]): string[] => {
  const f = diff(path, rows);
  const code = codeLines(f);
  return rows.flatMap((text, i) => mutantsFor(path, i + 1, text, code.get(i + 1)).map(m => `${i + 1}:${m.op}:${(m.original.slice(0, m.col) + m.to + m.original.slice(m.col + m.len)).trim()}`));
};
const ops = (path: string, rows: string[]): string[] => mutate(path, rows).map(x => x.split(':')[1]);

test('the operators are the ones the language has', () => {
  assert.deepEqual(ops('a.js', ['if (a === b) return 1;']).slice(0, 1), ['equality']);
  assert.match(mutate('a.js', ['if (a === b) return 1;'])[0], /a !== b/);
  // === is JavaScript's: Go and Python have ==
  assert.match(mutate('a.go', ['if a == b {'])[0], /a != b/);
  assert.match(mutate('a.py', ['if a == b:'])[0], /a != b/);
  assert.ok(!mutate('a.py', ['x = a and b'])[0].includes('&&'));
  assert.match(mutate('a.py', ['x = a and b'])[0], /a or b/);
  assert.match(mutate('a.java', ['boolean x = a && b;'])[0], /a \|\| b/);
  assert.equal(ops('a.py', ['x = a && b']).includes('and-or'), false, 'and in Python is a word, not &&');
  assert.match(mutate('a.rb', ['x = a || b'])[0], /a && b/);
  assert.match(mutate('a.lua', ['if a ~= b then'])[0], /a == b/);
});

test('a negation is found with or without parentheses, and as "not" where that is the word', () => {
  assert.match(mutate('a.java', ['if (!ok) return;']).join(), /1:negation:if \(ok\) return;/);
  assert.match(mutate('a.go', ['if !ok {']).join(), /1:negation:if ok \{/);
  assert.match(mutate('a.rs', ['if !ok {']).join(), /1:negation:if ok \{/);
  assert.match(mutate('a.py', ['if not ok:']).join(), /1:negation:if ok:/);
  assert.match(mutate('a.rb', ['if !ok']).join(), /1:negation:if ok/);
  assert.match(mutate('a.rb', ['if not ok']).join(), /1:negation:if ok/);
  assert.ok(!ops('a.go', ['if a != b {']).includes('negation'), 'a != is not a negation');
});

test('Python has its own: is None, True and False', () => {
  assert.match(mutate('a.py', ['if x is None:']).join(), /is not None/);
  assert.match(mutate('a.py', ['if x is not None:']).join(), /1:none-check:if x is None:/);
  assert.match(mutate('a.py', ['ok = True']).join(), /False/);
  assert.equal(ops('a.go', ['ok := True']).includes('boolean'), false, 'True is not a boolean in Go');
  assert.match(mutate('a.go', ['ok := true']).join(), /false/);
});

test('a comment is not code, in the language it is written in', () => {
  assert.deepEqual(mutate('a.py', ['# if a == b:']), []);
  assert.deepEqual(mutate('a.js', ['// if (a === b) {']), []);
  assert.deepEqual(mutate('a.lua', ['-- if a == b then']), []);
  assert.deepEqual(mutate('a.rb', ['# x = a && b']), []);
  // a comment after code: the code is mutated, the comment is not
  assert.match(mutate('a.py', ['x = a == b  # a != b']).join(), /1:equality:x = a != b  # a != b/);
  assert.deepEqual(ops('a.js', ['const s = 1; // a === b and c == d']), ['number']);
  // the same # is a comment in Python and an attribute in Rust: no mutant on the attribute line, one on the code
  assert.deepEqual(mutate('a.rs', ['#[derive(Debug)]']), []);
  assert.deepEqual(mutate('a.rs', ['#[cfg(test)]']), []);
});

test('the inside of a string, a block comment or a docstring is not code', () => {
  assert.deepEqual(mutate('a.js', ['const s = "a === b && c";']), []);
  assert.deepEqual(mutate('a.py', ["s = 'a == b and c'"]), []);
  const block = codeLines(diff('a.js', ['/* start of a comment', 'a === b && c', 'end */ const x = a === b;']));
  assert.equal(block.get(2)?.trim(), '', 'the middle of a block comment is blank');
  assert.match(String(block.get(3)), /const x = a === b;/, 'and the code after it is not');
  const doc = codeLines(diff('a.py', ['def f(a, b):', '    """', '    a == b and c', '    """', '    return a == b']));
  assert.equal(doc.get(3)?.trim(), '', 'the inside of a docstring is blank');
  assert.match(String(doc.get(5)), /return a == b/);
  const tick = codeLines(diff('a.js', ['const t = `a', 'b === c ${x}', 'd`; const y = a === b;']));
  assert.equal(tick.get(2)?.trim(), '', 'the inside of a template string is blank');
  assert.match(String(tick.get(3)), /a === b/);
});

test('a Rust lifetime is not the start of a string, a character literal is', () => {
  assert.match(mutate('a.rs', ['let r: &\'a str = if a == b { "x" } else { "y" };']).join(), /1:equality:let r: &'a str = if a != b/, 'the lifetime did not swallow the rest of the line');
  assert.deepEqual(mutate('a.rs', ["let c = '='; let d = 'a';"]).filter(x => x.includes('equality')), [], 'the = inside a char literal is not an operator');
  assert.match(mutate('a.go', ["if r == '=' {"]).join(), /1:equality:if r != '=' \{/);
});

test('a "+" that joins text, the length of an array type and an import are left alone', () => {
  assert.deepEqual(ops('a.js', ['const m = "hello " + name;']), [], 'joining text is not arithmetic');
  assert.ok(ops('a.rs', ['let m = a + b;']).includes('arithmetic'));
  assert.equal(ops('a.rs', ['let k: [u8; 32] = [0; 32];']).includes('number'), false, 'an array length is not a value to nudge');
  assert.ok(ops('a.go', ['x := 2 * y']).includes('arithmetic'));
  assert.deepEqual(mutate('a.py', ['from os import path']), []);
  assert.deepEqual(mutate('a.java', ['import java.util.List;']), []);
  assert.deepEqual(mutate('a.java', ['@Override']), []);
  assert.deepEqual(mutate('a.sql', ['select * from t where a = 1 and b = 2;']), [], 'SQL is not mutated: a change there is a different question');
});

test('mutants are picked by each file’s own language, and a line in a docstring is never picked', () => {
  const files = [
    diff('src/a.py', ['def f(a, b):', '    """', '    return a == b', '    """', '    return a == b']),
    diff('src/b.go', ['func g(a, b int) bool {', '\tif !ok {', '\t\treturn false', '\t}', '\treturn a == b', '}'])
  ];
  const picked = pickMutants(files, 10);
  assert.ok(picked.length >= 2);
  assert.ok(!picked.some(m => m.file === 'src/a.py' && m.line === 3), 'not the docstring');
  assert.ok(picked.some(m => m.file === 'src/a.py' && m.line === 5));
  assert.ok(picked.some(m => m.file === 'src/b.go' && m.op === 'negation'), 'a Go negation without parentheses');
});
