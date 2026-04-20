import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveConsensus } = await import('../dist/domains/community/resolveConsensus.js');

const fivePass = [
  { id: 'Q1', result: 'PASS' },
  { id: 'Q2', result: 'PASS' },
  { id: 'Q3', result: 'PASS' },
  { id: 'Q4', result: 'PASS' },
  { id: 'Q5', result: 'PASS' },
];

const entry = (catId, verdict, reasonCode) => ({
  catId,
  verdict,
  questions: fivePass,
  reasonCode,
  timestamp: Date.now(),
});

describe('resolveConsensus', () => {
  test('both WELCOME → consensus WELCOME, needsOwner false', () => {
    const r = resolveConsensus([entry('opus', 'WELCOME'), entry('codex', 'WELCOME')]);
    assert.equal(r.verdict, 'WELCOME');
    assert.equal(r.needsOwner, false);
  });

  test('both POLITELY-DECLINE → consensus POLITELY-DECLINE, needsOwner false', () => {
    const r = resolveConsensus([
      entry('opus', 'POLITELY-DECLINE', 'OUT_OF_SCOPE'),
      entry('codex', 'POLITELY-DECLINE', 'STACK_MISFIT'),
    ]);
    assert.equal(r.verdict, 'POLITELY-DECLINE');
    assert.equal(r.needsOwner, false);
    assert.ok(r.reasonCode);
  });

  test('WELCOME vs POLITELY-DECLINE → needsOwner true', () => {
    const r = resolveConsensus([entry('opus', 'WELCOME'), entry('codex', 'POLITELY-DECLINE', 'STACK_MISFIT')]);
    assert.equal(r.needsOwner, true);
    assert.equal(r.verdict, 'NEEDS-DISCUSSION');
  });

  test('WELCOME vs NEEDS-DISCUSSION → needsOwner true', () => {
    const r = resolveConsensus([entry('opus', 'WELCOME'), entry('codex', 'NEEDS-DISCUSSION')]);
    assert.equal(r.needsOwner, true);
  });

  test('both NEEDS-DISCUSSION → needsOwner true', () => {
    const r = resolveConsensus([entry('opus', 'NEEDS-DISCUSSION'), entry('codex', 'NEEDS-DISCUSSION')]);
    assert.equal(r.needsOwner, true);
    assert.equal(r.verdict, 'NEEDS-DISCUSSION');
  });

  test('single entry (bugfix shortcut) → uses that verdict, needsOwner false', () => {
    const r = resolveConsensus([entry('opus', 'WELCOME')]);
    assert.equal(r.verdict, 'WELCOME');
    assert.equal(r.needsOwner, false);
  });

  test('single POLITELY-DECLINE → needsOwner false (bug = cat auto-decides)', () => {
    const r = resolveConsensus([entry('opus', 'POLITELY-DECLINE', 'DUPLICATE')]);
    assert.equal(r.verdict, 'POLITELY-DECLINE');
    assert.equal(r.needsOwner, false);
    assert.equal(r.reasonCode, 'DUPLICATE');
  });

  test('empty entries throws', () => {
    assert.throws(() => resolveConsensus([]), /at least one/);
  });
});
