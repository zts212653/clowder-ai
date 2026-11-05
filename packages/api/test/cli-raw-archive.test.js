import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';

const { CliRawArchive } = await import('../dist/domains/cats/services/session/CliRawArchive.js');

const TEST_ARCHIVE_DIR = './test-cli-raw-archive';

async function readArchive(file) {
  return gunzipSync(await readFile(file)).toString('utf8');
}

describe('CliRawArchive', () => {
  beforeEach(async () => {
    if (existsSync(TEST_ARCHIVE_DIR)) {
      await rm(TEST_ARCHIVE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_ARCHIVE_DIR)) {
      await rm(TEST_ARCHIVE_DIR, { recursive: true, force: true });
    }
  });

  test('appends entries to the same invocation file in order', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    await archive.append('inv-1', { seq: 1, type: 'thread.started' });
    await archive.append('inv-1', { seq: 2, type: 'item.completed' });

    const file = archive.getPath('inv-1');
    assert.equal(existsSync(file), true);

    const content = await readArchive(file);
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.payload.seq, 1);
    assert.equal(second.payload.seq, 2);
  });

  test('writes different invocationIds to different files', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    await archive.append('inv-a', { marker: 'A' });
    await archive.append('inv-b', { marker: 'B' });

    const fileA = archive.getPath('inv-a');
    const fileB = archive.getPath('inv-b');

    assert.equal(existsSync(fileA), true);
    assert.equal(existsSync(fileB), true);

    const a = JSON.parse((await readArchive(fileA)).trim());
    const b = JSON.parse((await readArchive(fileB)).trim());
    assert.equal(a.payload.marker, 'A');
    assert.equal(b.payload.marker, 'B');
  });

  test('rejects invalid invocationId path traversal attempts', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    await assert.rejects(archive.append('../etc/passwd', { marker: 'x' }), /Invalid invocationId/);
  });

  test('supports concurrent append calls for same invocation', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    const events = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      type: 'item.completed',
    }));

    await Promise.all(events.map((event) => archive.append('inv-concurrent', event)));

    const file = archive.getPath('inv-concurrent');
    assert.equal(existsSync(file), true);

    const content = await readArchive(file);
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 20);

    const found = new Set(lines.map((line) => JSON.parse(line).payload.seq));
    assert.equal(found.size, 20);
    for (let i = 1; i <= 20; i += 1) {
      assert.equal(found.has(i), true);
    }
  });
});
