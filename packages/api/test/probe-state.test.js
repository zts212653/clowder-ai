import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildProbeState, computeToolDiff } from '../dist/config/capabilities/probe-state.js';

describe('ProbeState', () => {
  test('connected probe with tools sets ready', () => {
    const state = buildProbeState({
      connectionStatus: 'connected',
      tools: [{ name: 'read_file' }, { name: 'write_file' }],
    });
    assert.strictEqual(state.status, 'ready');
    assert.deepStrictEqual(state.probedTools, ['read_file', 'write_file']);
  });

  test('disconnected probe sets probe_failed with reason', () => {
    const state = buildProbeState({
      connectionStatus: 'disconnected',
      error: 'ECONNREFUSED',
    });
    assert.strictEqual(state.status, 'probe_failed');
    assert.strictEqual(state.failureReason, 'ECONNREFUSED');
  });

  test('unknown status sets not_probed', () => {
    const state = buildProbeState({ connectionStatus: 'unknown' });
    assert.strictEqual(state.status, 'not_probed');
  });

  test('lastProbed is valid ISO8601', () => {
    const state = buildProbeState({ connectionStatus: 'connected', tools: [] });
    assert.ok(!Number.isNaN(Date.parse(state.lastProbed)));
  });

  test('connected but no tools still ready', () => {
    const state = buildProbeState({ connectionStatus: 'connected', tools: [] });
    assert.strictEqual(state.status, 'ready');
    assert.deepStrictEqual(state.probedTools, []);
  });
});

describe('computeToolDiff', () => {
  test('no mismatch when identical', () => {
    const diff = computeToolDiff(['a', 'b'], ['a', 'b']);
    assert.strictEqual(diff.hasMismatch, false);
  });

  test('missing tools detected', () => {
    const diff = computeToolDiff(['a', 'b', 'c'], ['a', 'b']);
    assert.strictEqual(diff.hasMismatch, true);
    assert.deepStrictEqual(diff.missing, ['c']);
  });

  test('extra tools detected', () => {
    const diff = computeToolDiff(['a'], ['a', 'b']);
    assert.strictEqual(diff.hasMismatch, true);
    assert.deepStrictEqual(diff.extra, ['b']);
  });

  test('both missing and extra', () => {
    const diff = computeToolDiff(['a', 'b'], ['a', 'c']);
    assert.strictEqual(diff.hasMismatch, true);
    assert.deepStrictEqual(diff.missing, ['b']);
    assert.deepStrictEqual(diff.extra, ['c']);
  });

  test('empty declared = no mismatch', () => {
    const diff = computeToolDiff([], ['a']);
    assert.strictEqual(diff.hasMismatch, false);
  });

  test('tool diff blocks ready when declared tools present', () => {
    const state = buildProbeState(
      { connectionStatus: 'connected', tools: [{ name: 'a' }] },
      { declaredTools: ['a', 'b'] },
    );
    assert.strictEqual(state.status, 'probe_failed');
    assert.match(state.failureReason, /tool mismatch/i);
  });
});
