import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { gunzipSync } from 'node:zlib';

const { CliRawArchive } = await import('../dist/domains/cats/services/session/CliRawArchive.js');
let root;
let archive;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'raw-archive-gzip-'));
  archive = new CliRawArchive({ archiveDir: root });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

async function entries(invocationId, date) {
  const result = [];
  for await (const line of archive.readLines(invocationId, date)) result.push(JSON.parse(line));
  return result;
}

test('new archives are standard gzip with complete Unicode and tool payloads', async () => {
  const payload = { type: 'tool_result', text: '猫咖☀️\n代码差异\n'.repeat(20000), privateEvidence: { kept: true } };
  await archive.append('inv-roundtrip', payload);
  const path = archive.getPath('inv-roundtrip');
  assert.ok(path.endsWith('.ndjson.gz'));
  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  const entry = JSON.parse(gunzipSync(bytes).toString('utf8'));
  assert.deepEqual(entry.payload, payload);
  assert.equal(typeof entry.timestamp, 'number');
  assert.ok(bytes.length < Buffer.byteLength(JSON.stringify(entry)) / 10);
});

test('legacy and gzip parts of one invocation remain readable without rewriting legacy bytes', async () => {
  const path = archive.getPath('inv-mixed');
  const legacy = path.replace(/\.gz$/, '');
  await mkdir(dirname(path), { recursive: true });
  const original = `${JSON.stringify({ timestamp: 1, payload: { legacy: true } })}\n`;
  await writeFile(legacy, original);
  await archive.append('inv-mixed', { current: true });
  const read = await entries('inv-mixed');
  assert.deepEqual(
    read.map((entry) => entry.payload),
    [{ legacy: true }, { current: true }],
  );
  assert.equal(await readFile(legacy, 'utf8'), original);
});

test('concurrent appends and a new writer preserve every gzip member in call order', async () => {
  await Promise.all(Array.from({ length: 40 }, (_, seq) => archive.append('inv-concurrent', { seq })));
  const restarted = new CliRawArchive({ archiveDir: root });
  await restarted.append('inv-concurrent', { seq: 40 });
  assert.deepEqual(
    (await entries('inv-concurrent')).map((entry) => entry.payload.seq),
    Array.from({ length: 41 }, (_, seq) => seq),
  );
});

test('truncated gzip surfaces a read error and leaves the archive intact', async () => {
  await archive.append('inv-truncated', { original: 'kept' });
  const path = archive.getPath('inv-truncated');
  const full = await readFile(path);
  await writeFile(path, full.subarray(0, full.length - 6));
  const before = await stat(path);
  await assert.rejects(entries('inv-truncated'), /unexpected end|invalid|checksum|gzip/i);
  assert.equal((await stat(path)).size, before.size);
});

test('a failed append does not poison later writes for that invocation', async () => {
  const path = archive.getPath('inv-retry');
  await mkdir(path, { recursive: true });
  await assert.rejects(archive.append('inv-retry', { seq: 0 }));
  await rm(path, { recursive: true });
  await archive.append('inv-retry', { seq: 1 });
  assert.deepEqual(
    (await entries('inv-retry')).map((entry) => entry.payload),
    [{ seq: 1 }],
  );
});

test('reader preserves missing-day semantics and rejects traversal', async () => {
  assert.deepEqual(await entries('inv-absent', new Date(2026, 0, 1)), []);
  await assert.rejects(entries('../escape'), /Invalid invocationId/);
});

test('a reader can stop early without leaving a decompression pipeline running', async () => {
  await archive.append('inv-early-stop', { text: 'complete record'.repeat(10000) });
  await archive.append('inv-early-stop', { seq: 2 });
  let count = 0;
  for await (const line of archive.readLines('inv-early-stop')) {
    assert.ok(JSON.parse(line).payload.text);
    count++;
    break;
  }
  assert.equal(count, 1);
  assert.equal((await entries('inv-early-stop')).length, 2);
});
