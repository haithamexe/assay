import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProof, tierOf } from '../evidence.js';
import { nearestName } from '../checks/deps.js';
import { maskSecret, redactSecrets } from '../checks/secrets.js';
import { riskOf } from '../risk.js';

test('tierOf: proof beats everything, two sources corroborate, one source is a hint', () => {
  assert.equal(tierOf([{ kind: 'fact', source: 'fact:aws-key' }]), 'proven');
  assert.equal(tierOf([{ kind: 'rule', source: 'rule:a' }, { kind: 'test-fail', source: 'test' }]), 'proven');
  assert.equal(tierOf([{ kind: 'rule', source: 'rule:a' }, { kind: 'diff', source: 'diff:no-test' }]), 'corroborated');
  assert.equal(tierOf([{ kind: 'claim', source: 'reviewer:Security' }, { kind: 'claim', source: 'reviewer:Correctness' }]), 'corroborated');
  assert.equal(tierOf([{ kind: 'rule', source: 'rule:a' }]), 'hint');
  assert.equal(tierOf([{ kind: 'rule', source: 'rule:a' }, { kind: 'rule', source: 'rule:a' }]), 'hint', 'the same source twice is still one signal');
  assert.equal(tierOf([]), 'hint');
  assert.equal(isProof('claim'), false);
});

test('riskOf ranks proven above corroborated above hint, and a sensitive path above an ordinary one', () => {
  const mk = (tier: 'proven' | 'corroborated' | 'hint', file = 'src/x.ts') => riskOf({ severity: 'medium', tier, file, evidence: [{ kind: tier === 'proven' ? 'fact' : 'rule', source: 'rule:x' }] }).risk;
  assert.ok(mk('proven') > mk('corroborated'));
  assert.ok(mk('corroborated') > mk('hint'));
  assert.ok(mk('hint', 'src/auth/login.ts') > mk('hint'));
});

test('nearestName finds look-alikes and leaves real names alone', () => {
  assert.deepEqual(nearestName('reactt', [], ['react', 'lodash'])?.other, 'react');
  assert.equal(nearestName('react', [], ['react']), null);
  assert.equal(nearestName('expres', ['express'], [])?.other, 'express');
  assert.equal(nearestName('left-pad', ['right-pad'], []), null, 'four letters apart is a different package, not a look-alike');
  assert.equal(nearestName('abc', [], ['abd']), null, 'very short names are not compared');
  assert.equal(nearestName('totally-different', ['react'], ['lodash']), null);
});

test('secrets are masked everywhere they could show up', () => {
  assert.equal(maskSecret('AKIAQWERTYUIOP123456'), 'AKIA…(20 characters)');
  assert.equal(maskSecret('hunter2hunter2', 0), '•••(14 characters)');
  const line = 'key = "AKIAQWERTYUIOP123456"  # token: ghp_' + 'a'.repeat(36);
  const out = redactSecrets(line);
  assert.ok(!out.includes('QWERTYUIOP123456'));
  assert.ok(!out.includes('a'.repeat(30)));
  assert.ok(out.includes('AKIA…(20 characters)'));
  assert.equal(redactSecrets('AKIAIOSFODNN7EXAMPLE'), 'AKIAIOSFODNN7EXAMPLE', 'documented example keys are left alone');
});
