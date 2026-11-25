import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from '../diff.js';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 one
-two
+TWO
+two and a half
 three
 four
@@ -20,3 +21,3 @@ function x()
 a
-b
+c
 d
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
index 333..444 100644
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-hello
+hello there
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/gone.py b/gone.py
deleted file mode 100644
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-x = 1
-y = 2
`;

test('parseDiff reads files, hunks and real line numbers', () => {
  const files = parseDiff(SAMPLE);
  assert.equal(files.length, 4);
  const [a, r, img, gone] = files;
  assert.equal(a.path, 'src/a.ts');
  assert.equal(a.hunks.length, 2);
  assert.equal(a.additions, 3);
  assert.equal(a.deletions, 2);
  const added = a.hunks[0].lines.filter(l => l.t === '+');
  assert.deepEqual(added.map(l => [l.n, l.text]), [[2, 'TWO'], [3, 'two and a half']]);
  const removed = a.hunks[1].lines.find(l => l.t === '-')!;
  assert.equal(removed.o, 21);
  assert.equal(a.hunks[1].lines.find(l => l.t === '+')!.n, 22);
  assert.equal(r.status, 'renamed');
  assert.equal(r.path, 'new name.txt');
  assert.equal(r.oldPath, 'old name.txt');
  assert.equal(img.binary, true);
  assert.equal(img.status, 'added');
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.path, 'gone.py');
  assert.equal(gone.deletions, 2);
});

test('parseDiff survives an empty diff and a "no newline" marker', () => {
  assert.deepEqual(parseDiff(''), []);
  const f = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
  assert.equal(f[0].additions, 1);
  assert.equal(f[0].deletions, 1);
});
