import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { resolveSignalPaths } = await import('../dist/domains/signals/config/signal-paths.js');
const { readInboxRecords } = await import('../dist/domains/signals/services/inbox-records.js');

function createRecord(id, fetchedAt) {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    source: 'anthropic-news',
    tier: 1,
    fetchedAt,
    filePath: `/tmp/${id}.md`,
  };
}

describe('readInboxRecords', () => {
  let tempRoot;
  let paths;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-inbox-records-'));
    paths = resolveSignalPaths(tempRoot);
    mkdirSync(paths.inboxDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('maxRecords keeps latest records inside a single day file', async () => {
    const sameDayRecords = [
      createRecord('oldest', '2026-02-23T08:00:00.000Z'),
      createRecord('middle', '2026-02-23T09:00:00.000Z'),
      createRecord('newest', '2026-02-23T10:00:00.000Z'),
    ];
    writeFileSync(join(paths.inboxDir, '2026-02-23.json'), `${JSON.stringify(sameDayRecords, null, 2)}\n`, 'utf-8');

    const records = await readInboxRecords(paths, undefined, { maxRecords: 2 });
    const ids = records.map((record) => record.id);

    assert.deepEqual(ids, ['middle', 'newest']);
  });
});
