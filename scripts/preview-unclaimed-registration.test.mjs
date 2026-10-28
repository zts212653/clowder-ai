import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { unclaimed } from './lib/preview-unclaimed-test-fixture.mjs';

test('canonical stop retires only unclaimed registration, with durable limited status and nonzero CLI', async (t) => {
  const f = unclaimed(t);
  const before = [f.config.recordPath, f.record.completionPath, f.dumpFile].map((p) => readFileSync(p));
  const result = await stop(f);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.equal(existsSync(`${f.record.completionPath}.owner.json`), false);
  assert.equal(result.settlement.status, 'registration_retired');
  assert.equal(result.settlement.commandGroupStatus, 'unverified');
  assert.equal(result.settlement.cleanupExitCode, null);
  assert.equal(result.settlement.businessExitCode, 2);
  assert.equal(result.settlement.persistenceStatus, 'not_reverified');
  assert.equal('shutdownExitCode' in result.settlement, false);
  assert.deepEqual(readFileSync(f.record.completionPath), before[1]);
  assert.deepEqual(readFileSync(f.dumpFile), before[2]);
  const journal = result.settlement.journalPath;
  assert.deepEqual(readFileSync(join(journal, 'record.json')), before[0]);
  for (const action of ['stop', 'status'])
    for (const json of [true, false]) {
      const r = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
          action,
          '--cwd',
          f.mainRoot,
          '--port',
          String(f.config.port),
          ...(json ? ['--json'] : []),
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
        },
      );
      assert.equal(r.status, 3, r.stderr);
      if (json) assert.equal(JSON.parse(r.stdout).status, 'registration_retired');
      else {
        assert.match(r.stdout, /command group: unverified/);
        assert.match(r.stdout, /cleanup exit: unknown/);
      }
    }
});

test('absent data directory is recorded without creating an RDB', async (t) => {
  const f = unclaimed(t);
  rmSync(join(f.alphaRoot, '.cat-cafe/redis'), { recursive: true });
  const result = await stop(f);
  const receipt = JSON.parse(readFileSync(join(result.settlement.journalPath, 'result.json')));
  assert.equal(receipt.dataState.directoryPresent, false);
  assert.equal(existsSync(f.dumpFile), false);
});

test('a canonically released checkout can retire its old registration without recreating that checkout', async (t) => {
  const f = unclaimed(t);
  renameSync(f.alphaRoot, `${f.alphaRoot}.released`);
  f.git(['worktree', 'prune']);
  const result = await stop(f);
  assert.equal(result.settlement.status, 'registration_retired');
  assert.equal(existsSync(f.alphaRoot), false);
  const receipt = JSON.parse(readFileSync(join(result.settlement.journalPath, 'result.json')));
  assert.equal(receipt.dataState.checkoutPresent, false);
  assert.equal(receipt.dataState.directoryPresent, false);
  assert.equal(existsSync(join(`${f.alphaRoot}.released`, '.cat-cafe/redis/dump.rdb')), true);
});
