#!/usr/bin/env node
/**
 * F212 Phase H AC-H10 R2 P1-A + R3 P1-D: source/window fail-CLOSED tests.
 *
 * All P1-A #1..#3c + all P1-D #1..#5 (calendar validation) live here — window/
 * source validation is one concern cluster.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runReconciliation } from '../eval-f212-abnormal-exit-reconciliation.mjs';
import { scaffold } from './test-scaffold.mjs';

describe('F212 Phase H AC-H10 R2 P1-A + R3 P1-D: window/source fail-CLOSED', () => {
  it('R2 P1-A #1: single-file JSONL message store is a supported source shape', () => {
    const { archiveDir } = scaffold({
      archives: {
        'inv-single-file': [
          { timestamp: 1, payload: { type: 'error', message: 'x' } },
          {
            timestamp: 2,
            payload: {
              __cliError: true,
              cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-single-file' } },
            },
          },
        ],
      },
      messages: [],
    });
    const root = mkdtempSync(join(tmpdir(), 'f212-eval-single-'));
    const singleFile = join(root, 'store.jsonl');
    writeFileSync(
      singleFile,
      JSON.stringify({
        userId: 'system',
        catId: null,
        content: 'Error: single-file matched',
        metadata: { cliDiagnostics: { reasonCode: 'network_error', debugRef: { invocationId: 'inv-single-file' } } },
      }),
    );

    const result = runReconciliation({
      archiveDir,
      messageStorePath: singleFile,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'pass');
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].invocationId, 'inv-single-file');
  });

  it('R2 P1-A #2: missing archive directory → error verdict, not pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'f212-eval-msgs-'));
    const messageStorePath = join(root, 'msgs.jsonl');
    writeFileSync(messageStorePath, '');
    const result = runReconciliation({
      archiveDir: join(root, 'archive-that-does-not-exist'),
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });
    assert.notEqual(result.verdict, 'pass');
    assert.ok(result.verdict === 'error' || result.verdict === 'fail');
  });

  it('R2 P1-A #2b: missing message store path → error verdict', () => {
    const root = mkdtempSync(join(tmpdir(), 'f212-eval-arc-'));
    const archiveDir = join(root, 'cli-raw-archive');
    mkdirSync(archiveDir, { recursive: true });
    const result = runReconciliation({
      archiveDir,
      messageStorePath: join(root, 'store-that-does-not-exist'),
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });
    assert.notEqual(result.verdict, 'pass');
    assert.ok(result.verdict === 'error' || result.verdict === 'fail');
  });

  it('R2 P1-A #3a: since > until (invalid window) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-10',
      windowEnd: '2026-07-09',
    });
    assert.equal(result.verdict, 'error');
  });

  it('R2 P1-A #3b: malformed window (non YYYY-MM-DD) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: 'yesterday',
      windowEnd: '2026-07-10',
    });
    assert.equal(result.verdict, 'error');
  });

  it('R2 P1-A #3c: unbounded default window (both since AND until missing) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({ archiveDir, messageStorePath });
    assert.equal(result.verdict, 'error');
  });

  it('R3 P1-D #1: 2026-02-30 (Feb 30 does not exist) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-02-30',
      windowEnd: '2026-02-30',
    });
    assert.equal(result.verdict, 'error');
  });

  it('R3 P1-D #2: 2026-13-01 (month 13) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-13-01',
      windowEnd: '2026-13-01',
    });
    assert.equal(result.verdict, 'error');
  });

  it('R3 P1-D #3: 2027-02-29 (non-leap year) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2027-02-29',
      windowEnd: '2027-02-29',
    });
    assert.equal(result.verdict, 'error');
  });

  it('R3 P1-D #4: 2028-02-29 (real leap day) → NOT error', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2028-02-29',
      windowEnd: '2028-02-29',
    });
    assert.notEqual(result.verdict, 'error');
  });

  it('R3 P1-D #5: 2026-04-31 (April has 30 days) → error verdict', () => {
    const { archiveDir, messageStorePath } = scaffold({ archives: {}, messages: [] });
    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-04-31',
      windowEnd: '2026-04-31',
    });
    assert.equal(result.verdict, 'error');
  });
});
