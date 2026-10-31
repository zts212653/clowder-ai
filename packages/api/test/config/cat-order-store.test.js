import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { loadCatOrder, saveCatOrder } from '../../dist/config/cat-order-store.js';

describe('cat-order-store', () => {
  /** @type {string} */
  let projectRoot;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cat-order-'));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('loadCatOrder returns [] when preferences file does not exist', () => {
    assert.deepEqual(loadCatOrder(projectRoot), []);
  });

  test('saveCatOrder then loadCatOrder roundtrips', () => {
    saveCatOrder(projectRoot, ['opus-47', 'gpt52', 'gemini', 'opus']);
    assert.deepEqual(loadCatOrder(projectRoot), ['opus-47', 'gpt52', 'gemini', 'opus']);
  });

  test('saveCatOrder preserves other user-preferences fields', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cat-cafe', 'user-preferences.json'),
      JSON.stringify({ catOrder: [], futureField: 'keep-me' }),
      'utf-8',
    );
    saveCatOrder(projectRoot, ['opus']);
    const raw = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.equal(raw.futureField, 'keep-me');
    assert.deepEqual(raw.catOrder, ['opus']);
  });

  test('loadCatOrder ignores non-string entries', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cat-cafe', 'user-preferences.json'),
      JSON.stringify({ catOrder: ['opus', 42, null, 'codex'] }),
      'utf-8',
    );
    assert.deepEqual(loadCatOrder(projectRoot), ['opus', 'codex']);
  });

  test('loadCatOrder returns [] when file contains invalid JSON', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'not json at all', 'utf-8');
    assert.deepEqual(loadCatOrder(projectRoot), []);
  });
});
