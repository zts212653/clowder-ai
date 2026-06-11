import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  clearDriftIgnored,
  markDriftIgnored,
  readProjectState,
  writeProjectState,
} from '../../dist/config/mount/project-state-store.js';

let tempDir;

describe('ProjectStateStore (F228 Phase 4)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'project-state-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('readProjectState returns empty {version:1} when file does not exist', async () => {
    const state = await readProjectState(tempDir);
    assert.deepEqual(state, { version: 1 });
  });

  test('readProjectState returns empty on malformed JSON', async () => {
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(join(tempDir, '.cat-cafe/project-state.json'), 'not json');
    const state = await readProjectState(tempDir);
    assert.deepEqual(state, { version: 1 });
  });

  test('writeProjectState then readProjectState roundtrip', async () => {
    const input = { version: 1, ignoredDriftHash: 'abc123', ignoredAt: '2026-05-21T00:00:00Z' };
    await writeProjectState(tempDir, input);
    const back = await readProjectState(tempDir);
    assert.deepEqual(back, input);
  });

  test('markDriftIgnored sets hash + timestamp', async () => {
    await markDriftIgnored(tempDir, 'hash-xyz');
    const state = await readProjectState(tempDir);
    assert.equal(state.ignoredDriftHash, 'hash-xyz');
    assert.ok(state.ignoredAt, 'ignoredAt should be set');
    assert.match(state.ignoredAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('markDriftIgnored preserves other state fields', async () => {
    // hypothetical future field would be preserved; for now just verify version
    await markDriftIgnored(tempDir, 'first-hash');
    await markDriftIgnored(tempDir, 'second-hash');
    const state = await readProjectState(tempDir);
    assert.equal(state.ignoredDriftHash, 'second-hash');
    assert.equal(state.version, 1);
  });

  test('clearDriftIgnored removes hash + timestamp but keeps version', async () => {
    await markDriftIgnored(tempDir, 'hash-xyz');
    await clearDriftIgnored(tempDir);
    const state = await readProjectState(tempDir);
    assert.deepEqual(state, { version: 1 });
  });

  test('readProjectState ignores wrong version', async () => {
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(tempDir, '.cat-cafe/project-state.json'),
      JSON.stringify({ version: 99, ignoredDriftHash: 'should-be-ignored' }),
    );
    const state = await readProjectState(tempDir);
    assert.deepEqual(state, { version: 1 });
  });

  test('readProjectState ignores empty-string ignoredDriftHash', async () => {
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(tempDir, '.cat-cafe/project-state.json'),
      JSON.stringify({ version: 1, ignoredDriftHash: '', ignoredAt: '' }),
    );
    const state = await readProjectState(tempDir);
    assert.deepEqual(state, { version: 1 });
  });
});
