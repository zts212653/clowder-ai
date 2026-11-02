import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeCatCatalog } from '../../dist/config/cat-catalog-store.js';
import { toAllCatConfigs } from '../../dist/config/cat-config-loader.js';
import { readRuntimeCatCatalog, updateRuntimeCat } from '../../dist/config/runtime-cat-catalog.js';

test('member approval survives reload and unrelated edits without changing connection or history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acp-member-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  writeCatCatalog(
    root,
    JSON.parse(await readFile(fileURLToPath(new URL('../../../../cat-template.json', import.meta.url)), 'utf8')),
  );
  const history = join(root, 'history.ndjson');
  await writeFile(history, 'KEEP HISTORY');
  const before = readRuntimeCatCatalog(root);
  assert.equal(toAllCatConfigs(before).codex.executionApproval, undefined);
  await updateRuntimeCat(root, 'codex', { executionApproval: 'ask_user' });
  assert.equal(toAllCatConfigs(readRuntimeCatCatalog(root)).codex.executionApproval, 'ask_user');
  await updateRuntimeCat(root, 'codex', { nickname: 'Review companion' });
  assert.equal(toAllCatConfigs(readRuntimeCatCatalog(root)).codex.executionApproval, 'ask_user');
  await updateRuntimeCat(root, 'codex', { executionApproval: 'auto' });
  assert.equal(toAllCatConfigs(readRuntimeCatCatalog(root)).codex.executionApproval, 'auto');
  assert.equal(await readFile(history, 'utf8'), 'KEEP HISTORY');
  const after = toAllCatConfigs(readRuntimeCatCatalog(root));
  assert.deepEqual(after.opus, toAllCatConfigs(before).opus);
});
