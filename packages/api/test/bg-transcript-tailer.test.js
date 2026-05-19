/**
 * F198 Phase B Step 2 slice 2: TranscriptTailer
 *
 * Incremental reader for `claude --bg` transcript jsonl. The carrier
 * `invoke()` polls this on every tick to emit AgentMessages as new
 * assistant turns land (per-message streaming, R2 hard requirement).
 *
 * Critical contracts:
 * - 1st call → all complete lines so far
 * - subsequent calls → only NEW lines since last call (no replay)
 * - partial last line (no trailing \n) → held back until next full write
 *   (avoids JSON.parse failures on partial daemon writes)
 * - malformed JSON line → skipped per-line (does not abort tailer)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptTailer } from '../dist/domains/cats/services/agents/providers/TranscriptTailer.js';

function tmpFile(name = 'transcript.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-tailer-test-'));
  return join(dir, name);
}

test('TranscriptTailer: nonexistent file → returns empty entries (job not started yet)', async () => {
  const tailer = new TranscriptTailer('/nonexistent/path.jsonl');
  const entries = await tailer.readNew();
  assert.deepEqual(entries, []);
});

test('TranscriptTailer: first call returns all complete lines', async () => {
  const path = tmpFile();
  writeFileSync(path, '{"type":"assistant","i":1}\n{"type":"user","i":2}\n');
  const tailer = new TranscriptTailer(path);
  const entries = await tailer.readNew();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].i, 1);
  assert.equal(entries[1].i, 2);
});

test('TranscriptTailer: subsequent call returns only new lines', async () => {
  const path = tmpFile();
  writeFileSync(path, '{"type":"assistant","i":1}\n');
  const tailer = new TranscriptTailer(path);
  const first = await tailer.readNew();
  assert.equal(first.length, 1);

  // Append two more complete lines
  writeFileSync(path, '{"type":"assistant","i":1}\n{"type":"assistant","i":2}\n{"type":"system","i":3}\n');
  const second = await tailer.readNew();
  assert.equal(second.length, 2);
  assert.equal(second[0].i, 2);
  assert.equal(second[1].i, 3);

  // Third call with no growth → empty
  const third = await tailer.readNew();
  assert.deepEqual(third, []);
});

test('TranscriptTailer: partial last line (no trailing \\n) held back until full write', async () => {
  const path = tmpFile();
  // Daemon mid-write: complete line + partial second line
  writeFileSync(path, '{"type":"assistant","i":1}\n{"type":"assist');
  const tailer = new TranscriptTailer(path);
  const first = await tailer.readNew();
  assert.equal(first.length, 1, 'only complete first line emitted; partial held back');

  // Daemon finishes the write
  writeFileSync(path, '{"type":"assistant","i":1}\n{"type":"assistant","i":2}\n');
  const second = await tailer.readNew();
  assert.equal(second.length, 1);
  assert.equal(second[0].i, 2);
});

test('TranscriptTailer: malformed JSON line skipped per-line (does not abort)', async () => {
  const path = tmpFile();
  writeFileSync(path, '{"type":"assistant","i":1}\nNOT JSON\n{"type":"assistant","i":3}\n');
  const tailer = new TranscriptTailer(path);
  const entries = await tailer.readNew();
  assert.equal(entries.length, 2, 'malformed line skipped; valid lines preserved');
  assert.equal(entries[0].i, 1);
  assert.equal(entries[1].i, 3);
});

test('TranscriptTailer: empty file → empty entries', async () => {
  const path = tmpFile();
  writeFileSync(path, '');
  const tailer = new TranscriptTailer(path);
  const entries = await tailer.readNew();
  assert.deepEqual(entries, []);
});

test('TranscriptTailer: includeTrailingPartial: true → complete-but-newline-less last line emitted (final drain)', async () => {
  // codex slice-2 P1 (regression B): daemon flush race where state=done was
  // committed before transcript got its final \n. Final-drain mode must
  // attempt JSON.parse on the trailing segment and include it if valid.
  const path = tmpFile();
  writeFileSync(path, '{"type":"assistant","i":1}'); // complete JSON, NO trailing \n
  const tailer = new TranscriptTailer(path);

  // Streaming mode (default) — must NOT emit (could be partial mid-write).
  const streaming = await tailer.readNew();
  assert.equal(streaming.length, 0, 'streaming mode holds trailing partial');

  // Final drain — must emit (JSON.parse succeeds → complete-but-newline-less).
  const final = await tailer.readNew({ includeTrailingPartial: true });
  assert.equal(final.length, 1);
  assert.equal(final[0].i, 1);
});

test('TranscriptTailer: includeTrailingPartial: true with truly partial JSON → still dropped', async () => {
  // Guard: includeTrailingPartial must NOT surface half-written lines —
  // only complete JSON that happens to lack \n. JSON.parse failure = drop.
  const path = tmpFile();
  writeFileSync(path, '{"type":"assistant","i":1}\n{"type":"assist'); // last line truly partial
  const tailer = new TranscriptTailer(path);
  const entries = await tailer.readNew({ includeTrailingPartial: true });
  assert.equal(entries.length, 1, 'truly partial line dropped even in final-drain mode');
  assert.equal(entries[0].i, 1);
});

test('TranscriptTailer: pure newlines (blank lines) skipped', async () => {
  const path = tmpFile();
  writeFileSync(path, '\n\n{"type":"assistant","i":1}\n\n');
  const tailer = new TranscriptTailer(path);
  const entries = await tailer.readNew();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].i, 1);
});
