#!/usr/bin/env node
/**
 * F212 Phase H AC-H10 Sol Final确权 P1-B (2026-07-10): malformed archive fail-CLOSED.
 * JSON parse errors + missing/non-numeric timestamps must propagate to verdict:error.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runReconciliation } from '../eval-f212-abnormal-exit-reconciliation.mjs';

function scaffoldMalformed(archiveContents) {
  const root = mkdtempSync(join(tmpdir(), 'f212-malformed-'));
  const archiveDir = join(root, 'cli-raw-archive');
  const dayDir = join(archiveDir, '2026-07-09');
  mkdirSync(dayDir, { recursive: true });
  for (const [id, raw] of Object.entries(archiveContents)) {
    writeFileSync(join(dayDir, `${id}.ndjson`), raw);
  }
  const messageStorePath = join(root, 'messages');
  mkdirSync(messageStorePath, { recursive: true });
  writeFileSync(join(messageStorePath, 'msgs.jsonl'), '');
  return { archiveDir, messageStorePath };
}

describe('F212 Phase H AC-H10 Sol Final确权 P1-B: malformed archive fail-CLOSED', () => {
  it('P1-B #1: archive with a JSON parse error line → verdict:error (not silent pass)', () => {
    // Sol's exact repro: one stream error + one CORRUPT __cliError line.
    // Old behavior: silent skip → verdict:pass. New: verdict:error with pointer.
    const raw = [
      JSON.stringify({ timestamp: 1, payload: { type: 'error', message: 'x' } }),
      '{ "timestamp": 2, "payload": { "__cliError": true,  ', // CORRUPT JSON
    ].join('\n');
    const { archiveDir, messageStorePath } = scaffoldMalformed({ 'inv-corrupt': raw });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'error', 'malformed JSON line MUST produce verdict:error');
    assert.ok(
      result.error.includes('malformed') && result.error.includes('inv-corrupt'),
      `error should name the file + line; got: ${result.error}`,
    );
  });

  it('P1-B #2: archive with missing timestamp → verdict:error', () => {
    // Record lacks `timestamp` — old behavior: NaN → sort to end → silent.
    const raw = [
      JSON.stringify({ timestamp: 1, payload: { type: 'error', message: 'x' } }),
      JSON.stringify({ payload: { __cliError: true, cliDiagnostics: { debugRef: { invocationId: 'inv-no-ts' } } } }),
    ].join('\n');
    const { archiveDir, messageStorePath } = scaffoldMalformed({ 'inv-no-ts': raw });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'error', 'missing timestamp MUST produce verdict:error');
    assert.ok(result.error.includes('timestamp'), `error should name the missing timestamp; got: ${result.error}`);
  });

  it('P1-B #3: archive with non-numeric timestamp (string) → verdict:error', () => {
    const raw = JSON.stringify({
      timestamp: 'not-a-number',
      payload: { __cliError: true },
    });
    const { archiveDir, messageStorePath } = scaffoldMalformed({ 'inv-str-ts': raw });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'error');
  });

  it('Sol R6 P2: malformed error reports 1-based PHYSICAL line number (not zero-based post-blank-filter)', () => {
    // Sol's exact complaint: with a corrupt line at physical file position 2
    // (after 1 valid line), the old error said "line 1" because it used a
    // 0-based index over the blank-filtered array. Real editor line numbers
    // are 1-based and count blanks.
    const raw = [
      JSON.stringify({ timestamp: 1, payload: { type: 'error', message: 'x' } }), // physical line 1
      '', // blank — physical line 2, silently skipped by scanner
      '{ "timestamp": 3, malformed', // physical line 3 — the actual bad one
    ].join('\n');
    const { archiveDir, messageStorePath } = scaffoldMalformed({ 'inv-line-num': raw });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'error');
    assert.ok(
      result.error.includes('line 3'),
      `error must report 1-based physical line number (expected "line 3"); got: ${result.error}`,
    );
  });

  it('P1-B #4: perfectly-formed archive still passes (no regression)', () => {
    const raw = [
      JSON.stringify({ timestamp: 1, payload: { type: 'thread.started' } }),
      JSON.stringify({ timestamp: 2, payload: { type: 'turn.completed' } }),
    ].join('\n');
    const { archiveDir, messageStorePath } = scaffoldMalformed({ 'inv-clean': raw });

    const result = runReconciliation({
      archiveDir,
      messageStorePath,
      windowStart: '2026-07-09',
      windowEnd: '2026-07-09',
    });

    assert.equal(result.verdict, 'pass', 'well-formed clean archive must still pass');
  });
});
