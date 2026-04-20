import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';
import { SkillSecurityStore } from '../dist/skill-security/skill-security-store.js';

describe('SkillSecurityStore', () => {
  let store;

  const regData = { source: '/path/to/skill', version: '1.0.0', content: '# Safe Skill\nHelp users.' };

  beforeEach(() => {
    store = SkillSecurityStore.createInMemory();
  });

  test('register creates entry with pending_review status', () => {
    const entry = store.register('my-skill', regData);
    assert.strictEqual(entry.status, 'pending_review');
    assert.strictEqual(entry.skillId, 'my-skill');
  });

  test('fingerprint uses SHA-256 of content', () => {
    const entry = store.register('s1', regData);
    const expected = crypto.createHash('sha256').update(regData.content).digest('hex');
    assert.strictEqual(entry.fingerprint.contentHash, expected);
  });

  test('fingerprint records source and version', () => {
    const entry = store.register('s1', regData);
    assert.strictEqual(entry.fingerprint.source, '/path/to/skill');
    assert.strictEqual(entry.fingerprint.version, '1.0.0');
  });

  test('approve transitions pending_review to approved', () => {
    store.register('s1', regData);
    const entry = store.approve('s1', 'you');
    assert.strictEqual(entry.status, 'approved');
    assert.strictEqual(entry.approvedBy, 'you');
    assert.ok(entry.approvedAt);
  });

  test('approve transitions quarantined to approved', () => {
    store.register('s1', regData);
    store.quarantine('s1', [{ pattern: 'test', severity: 'warning', line: 1, context: '' }]);
    const entry = store.approve('s1', 'you');
    assert.strictEqual(entry.status, 'approved');
  });

  test('quarantine sets status and stores findings', () => {
    store.register('s1', regData);
    const findings = [{ pattern: 'evil', severity: 'critical', line: 1, context: 'bad stuff' }];
    store.quarantine('s1', findings);
    const entry = store.get('s1');
    assert.strictEqual(entry.status, 'quarantined');
    assert.strictEqual(entry.scanFindings.length, 1);
  });

  test('verifyFingerprint passes with same content', () => {
    store.register('s1', regData);
    const result = store.verifyFingerprint('s1', regData.content);
    assert.strictEqual(result.valid, true);
  });

  test('verifyFingerprint detects content change', () => {
    store.register('s1', regData);
    const result = store.verifyFingerprint('s1', 'tampered content');
    assert.strictEqual(result.valid, false);
  });

  test('fingerprint mismatch auto-quarantines approved skill', () => {
    store.register('s1', regData);
    store.approve('s1', 'you');
    store.verifyFingerprint('s1', 'tampered');
    assert.strictEqual(store.get('s1').status, 'quarantined');
  });

  test('revoke marks entry as rejected', () => {
    store.register('s1', regData);
    store.approve('s1', 'you');
    store.revoke('s1', 'opus');
    const entry = store.get('s1');
    assert.strictEqual(entry.status, 'rejected');
    assert.strictEqual(entry.revokedBy, 'opus');
    assert.ok(entry.revokedAt);
  });

  test('get returns undefined for unknown skill', () => {
    assert.strictEqual(store.get('nonexistent'), undefined);
  });

  test('list returns all entries', () => {
    store.register('s1', regData);
    store.register('s2', { ...regData, source: '/other' });
    assert.strictEqual(store.list().length, 2);
  });

  test('approve throws on rejected (terminal) entry', () => {
    store.register('s1', regData);
    store.approve('s1', 'you');
    store.revoke('s1', 'opus');
    assert.throws(() => store.approve('s1', 'you'), /rejected.*terminal/i);
  });

  test('quarantine throws on rejected (terminal) entry', () => {
    store.register('s1', regData);
    store.revoke('s1', 'opus');
    assert.throws(
      () => store.quarantine('s1', [{ pattern: 'test', severity: 'warning', line: 1, context: '' }]),
      /rejected.*terminal/i,
    );
  });
});
