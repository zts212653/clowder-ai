import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { runReconciliation } from './reconciliation.mjs';

test('F212 includes gzip archive failures and keeps corruption fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'f212-gzip-'));
  try {
    const day = join(root, 'archive', '2026-10-19');
    mkdirSync(day, { recursive: true });
    const messages = join(root, 'messages.jsonl');
    writeFileSync(messages, '');
    const archive = join(day, 'inv-gzip.ndjson.gz');
    const body = [
      { timestamp: 1, payload: { type: 'error' } },
      { timestamp: 2, payload: { __cliError: true } },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join('');
    writeFileSync(archive, gzipSync(body));
    const opts = {
      archiveDir: join(root, 'archive'),
      messageStorePath: messages,
      windowStart: '2026-10-19',
      windowEnd: '2026-10-19',
    };
    const result = runReconciliation(opts);
    assert.equal(result.verdict, 'fail');
    assert.equal(result.totalAbnormalExits, 1);
    assert.equal(result.unmatched[0].invocationId, 'inv-gzip');
    writeFileSync(archive, Buffer.from([0x1f, 0x8b, 0]));
    const corrupt = runReconciliation(opts);
    assert.equal(corrupt.verdict, 'error');
    assert.match(corrupt.error, /archive|gzip|end/i);
    writeFileSync(archive, gzipSync('\ninvalid JSON\n'));
    const malformed = runReconciliation(opts);
    assert.equal(malformed.verdict, 'error');
    assert.match(malformed.error, /inv-gzip\.ndjson\.gz line 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy failure and compressed recovery are reconciled as one invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'f212-gzip-mixed-'));
  try {
    const day = join(root, 'archive', '2026-10-19');
    mkdirSync(day, { recursive: true });
    const messages = join(root, 'messages.jsonl');
    writeFileSync(messages, '');
    const before = [
      { timestamp: 1, payload: { type: 'error' } },
      { timestamp: 2, payload: { __cliError: true } },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join('');
    writeFileSync(join(day, 'inv-mixed.ndjson'), before);
    writeFileSync(
      join(day, 'inv-mixed.ndjson.gz'),
      gzipSync(`${JSON.stringify({ timestamp: 3, payload: { type: 'turn.completed' } })}\n`),
    );
    const result = runReconciliation({
      archiveDir: join(root, 'archive'),
      messageStorePath: messages,
      windowStart: '2026-10-19',
      windowEnd: '2026-10-19',
    });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.totalAbnormalExits, 0);
    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].invocationId, 'inv-mixed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
