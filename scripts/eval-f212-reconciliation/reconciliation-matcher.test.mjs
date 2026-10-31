#!/usr/bin/env node
/**
 * F212 Phase H AC-H10 R2 P1-B: matcher strict-shape tests.
 * Non-error records with same invocationId must NOT satisfy the invariant.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runReconciliation } from '../eval-f212-abnormal-exit-reconciliation.mjs';
import { scaffold } from './test-scaffold.mjs';

describe('F212 Phase H AC-H10 R2 P1-B: matcher requires real F212 error shape', () => {
  it('R2 P1-B #1: non-error record with same invocationId does NOT match', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-only-sysinfo': [
          { timestamp: 1, payload: { type: 'error', message: 'stream disconnected' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-only-sysinfo' } },
            },
          },
        ],
      },
      messages: [
        {
          userId: 'default-user',
          catId: 'codex',
          content: 'diagnostic emitted',
          metadata: {
            cliDiagnostics: {
              reasonCode: 'network_error',
              debugRef: { invocationId: 'inv-only-sysinfo' },
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
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-only-sysinfo');
  });

  it('R2 P1-B #2: legacy content-substring fallback only accepts real Error: prefix + system shape', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-legacy': [
          { timestamp: 1, payload: { type: 'error', message: 'x' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-legacy' } },
            },
          },
        ],
      },
      messages: [
        {
          userId: 'system',
          catId: null,
          content: 'Error: CLI 异常退出 (inv-legacy)',
          metadata: {},
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
    assert.equal(result.matched.length, 1);
  });

  it('R2 P1-B #3: legacy fallback rejects non-system content mentioning invocationId', () => {
    const { archiveDir, messageStorePath } = scaffold({
      archives: {
        'inv-narrative': [
          { timestamp: 1, payload: { type: 'error', message: 'x' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-narrative' } },
            },
          },
        ],
      },
      messages: [
        {
          userId: 'default-user',
          catId: 'codex',
          content: 'debug ref inv-narrative appeared here',
          metadata: {},
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
  });
});
