#!/usr/bin/env node
/**
 * F212 Phase H AC-H10 R1: baseline reconciliation contract tests.
 * `∀ (invocationId): abnormal exit + streamErrorCount>0 ↔ persisted F212 error`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runReconciliation } from '../eval-f212-abnormal-exit-reconciliation.mjs';
import { scaffold } from './test-scaffold.mjs';

describe('F212 Phase H AC-H10 R1: baseline reconciliation', () => {
  it('pass: every abnormal exit with streamErrorCount>0 has a persisted F212 error', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-A': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'error', message: 'flagged for possible cybersecurity risk' } },
          { timestamp: 3, payload: { type: 'turn.failed', error: { message: 'policy' } } },
          {
            timestamp: 4,
            payload: {
              __cliError: true,
              exitCode: 1,
              signal: null,
              cliDiagnostics: {
                reasonCode: 'upstream_policy_reject',
                debugRef: { invocationId: 'inv-A', command: 'codex', exitCode: 1, signal: null },
              },
            },
          },
        ],
      },
      messages: [
        {
          userId: 'system',
          catId: null,
          content: 'Error: upstream policy reject',
          metadata: {
            cliDiagnostics: {
              reasonCode: 'upstream_policy_reject',
              debugRef: { invocationId: 'inv-A' },
            },
          },
        },
      ],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'pass');
    assert.equal(result.totalAbnormalExits, 1);
    assert.equal(result.matched.length, 1);
    assert.equal(result.unmatched.length, 0);
  });

  it('fail: silent-false-success — abnormal exit emitted but NO persistence = verdict fail', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-silent': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'error', message: 'flagged for possible cybersecurity risk' } },
          { timestamp: 3, payload: { type: 'turn.failed', error: { message: 'policy' } } },
          {
            timestamp: 4,
            payload: {
              __cliError: true,
              exitCode: 1,
              signal: null,
              cliDiagnostics: {
                reasonCode: 'upstream_policy_reject',
                debugRef: { invocationId: 'inv-silent', command: 'codex', exitCode: 1, signal: null },
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
    assert.equal(result.totalAbnormalExits, 1);
    assert.equal(result.matched.length, 0);
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-silent');
  });

  it('pass: clean success (turn.completed, no __cliError, no stream error) is NOT counted', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-clean': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'turn.started' } },
          { timestamp: 3, payload: { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } } },
          { timestamp: 4, payload: { type: 'turn.completed' } },
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
    assert.equal(result.totalAbnormalExits, 0);
  });

  it('pass: mixed window with success + persisted-abnormal-exit + silent-mask → fails on silent-mask alone', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-ok': [
          { timestamp: 1, payload: { type: 'thread.started' } },
          { timestamp: 2, payload: { type: 'turn.started' } },
          { timestamp: 3, payload: { type: 'turn.completed' } },
        ],
        'inv-persisted': [
          { timestamp: 1, payload: { type: 'error', message: '429' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: {
                reasonCode: 'quota_exceeded',
                debugRef: { invocationId: 'inv-persisted' },
              },
            },
          },
        ],
        'inv-mask': [
          { timestamp: 1, payload: { type: 'error', message: 'flagged for possible cybersecurity risk' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: {
                reasonCode: 'upstream_policy_reject',
                debugRef: { invocationId: 'inv-mask' },
              },
            },
          },
        ],
      },
      messages: [
        {
          userId: 'system',
          catId: null,
          content: 'Error: 429',
          metadata: {
            cliDiagnostics: {
              reasonCode: 'quota_exceeded',
              debugRef: { invocationId: 'inv-persisted' },
            },
          },
        },
      ],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'fail');
    assert.equal(result.totalAbnormalExits, 2);
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].invocationId, 'inv-persisted');
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-mask');
    assert.equal(result.unmatched[0].reasonCode, 'upstream_policy_reject');
  });

  it('bounded: entries outside the [since, until] window are ignored', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-out-of-window': [
          { timestamp: 1, payload: { type: 'error', message: 'x' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-out-of-window' } },
            },
          },
        ],
      },
      messages: [],
    });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-10',
      windowEnd: '2026-07-11',
    });

    assert.equal(result.verdict, 'pass');
    assert.equal(result.totalAbnormalExits, 0);
  });
});
