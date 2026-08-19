#!/usr/bin/env node
/**
 * F212 Phase H AC-H10 R3 P1-C + Cloud R1 P2: sequence-aware scanner tests.
 * Recovery (finalTerminal=turn.completed) excluded from abnormal universe.
 * Timestamp-based sort keeps recovery correctly classified under out-of-order flush.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runReconciliation } from '../eval-f212-abnormal-exit-reconciliation.mjs';
import { scaffold } from './test-scaffold.mjs';

describe('F212 Phase H AC-H10 R3 P1-C + Cloud R1 P2: sequence-aware scanner', () => {
  it('R3 P1-C #1: real 217969a7 recovery pattern (__cliError then turn.completed) is NOT unmatched', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-recovery': [
          { timestamp: 1, payload: { type: 'thread.started', thread_id: 'tx-1' } },
          { timestamp: 2, payload: { type: 'turn.started' } },
          { timestamp: 3, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 4, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 5, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 6, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 7, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 8, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 9, payload: { type: 'turn.failed', error: { message: 'x' } } },
          {
            timestamp: 10,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-recovery' } },
            },
          },
          { timestamp: 11, payload: { type: 'thread.started', thread_id: 'tx-2' } },
          { timestamp: 12, payload: { type: 'turn.started' } },
          { timestamp: 13, payload: { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } } },
          { timestamp: 14, payload: { type: 'turn.completed' } },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'pass');
    assert.equal(result.unmatched.length, 0);
    assert.equal(result.totalAbnormalExits, 0);
    assert.ok(Array.isArray(result.recovered));
    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].invocationId, 'inv-recovery');
  });

  it('R3 P1-C #2: recovery followed by another failure IS still counted', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-recover-then-fail': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'turn.started' } },
          { timestamp: 3, payload: { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } } },
          { timestamp: 4, payload: { type: 'turn.completed' } },
          { timestamp: 5, payload: { type: 'turn.started' } },
          { timestamp: 6, payload: { type: 'error', message: 'final failure' } },
          { timestamp: 7, payload: { type: 'turn.failed', error: { message: 'terminal' } } },
          {
            timestamp: 8,
            payload: {
              __cliError: true,
              cliDiagnostics: {
                reasonCode: 'network_error',
                debugRef: { invocationId: 'inv-recover-then-fail' },
              },
            },
          },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'fail');
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-recover-then-fail');
  });

  it('R3 P1-C #3: cyber-safety 97449e4b shape still counts (final terminal = __cliError)', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-97449e4b': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'turn.started' } },
          { timestamp: 3, payload: { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } } },
          { timestamp: 4, payload: { type: 'error', message: 'flagged for possible cybersecurity risk' } },
          { timestamp: 5, payload: { type: 'turn.failed', error: { message: 'policy' } } },
          {
            timestamp: 6,
            payload: {
              __cliError: true,
              cliDiagnostics: {
                reasonCode: 'upstream_policy_reject',
                debugRef: { invocationId: 'inv-97449e4b' },
              },
            },
          },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'fail');
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-97449e4b');
  });

  it('cloud R1 P2 #1: out-of-order NDJSON (turn.completed flushed BEFORE __cliError physically) recovery still classified correctly', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-oof-recovery': [
          { timestamp: 14, payload: { type: 'turn.completed' } },
          {
            timestamp: 10,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-oof-recovery' } },
            },
          },
          { timestamp: 3, payload: { type: 'error', message: 'stream disconnected' } },
          { timestamp: 9, payload: { type: 'turn.failed', error: { message: 'x' } } },
          { timestamp: 11, payload: { type: 'thread.started' } },
          { timestamp: 12, payload: { type: 'turn.started' } },
          { timestamp: 13, payload: { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } } },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'pass');
    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].invocationId, 'inv-oof-recovery');
    assert.equal(result.totalAbnormalExits, 0);
  });

  it('cloud R1 P2 #2: out-of-order NDJSON (turn.completed early, __cliError late chronologically) → correctly counted as abnormal', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-oof-then-fail': [
          {
            timestamp: 100,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-oof-then-fail' } },
            },
          },
          { timestamp: 50, payload: { type: 'turn.completed' } },
          { timestamp: 10, payload: { type: 'thread.started' } },
          { timestamp: 40, payload: { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } } },
          { timestamp: 60, payload: { type: 'error', message: 'later failure' } },
          { timestamp: 90, payload: { type: 'turn.failed', error: { message: 'terminal' } } },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'fail');
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-oof-then-fail');
  });

  it('cloud R1 P2 #3: records with identical timestamp preserve archived order (stable sort)', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-stable-sort': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'turn.completed' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-stable-sort' } },
            },
          },
          { timestamp: 1, payload: { type: 'error', message: 'x' } },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'fail');
    assert.equal(result.unmatched.length, 1);
  });
});
