import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { readUnixProcessSnapshot, readUnixProcessSnapshotSync } from '../dist/utils/cli-process-ownership.js';
import { largePsFixture } from './helpers/large-ps-snapshot.mjs';

test('macOS sync/async production readers bound environment scans and preserve unknown evidence', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originals = { spawnSync: cp.spawnSync, execFile: cp.execFile, execFileSync: cp.execFileSync };
  let fixture;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  cp.spawnSync = (file, args, options) => originals.spawnSync(file, fixture.command(args), options);
  cp.execFile = (file, args, options, callback) => originals.execFile(file, fixture.command(args), options, callback);
  syncBuiltinESMExports();
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    Object.assign(cp, originals);
    syncBuiltinESMExports();
  });
  for (const reader of [readUnixProcessSnapshotSync, readUnixProcessSnapshot]) {
    fixture = largePsFixture();
    const options = { includeEnvironment: true, environmentMarkers: [`CAT_CAFE_GATE_JOB_TOKEN=${fixture.token}`] };
    const result = await reader(options);
    assert.ok(result, 'an aggregate >32 MiB must not make process ownership unknown');
    assert.equal(result.size, fixture.pids.length);
    assert.equal(
      result.get(fixture.pids[0]).commandAndEnvironment,
      `CAT_CAFE_PROCESS_OWNER_ID=${fixture.ownerId}`,
      'all identities and CLI ownership markers remain without unrelated payloads',
    );
    assert.match(
      result.get(fixture.targetPid).commandAndEnvironment,
      /CAT_CAFE_GATE_JOB_TOKEN=bounded-snapshot-target$/,
    );
    fixture = largePsFixture({ failPid: 2_000_599, matchFirst: true });
    assert.equal(await reader(options), null, 'partial scans are never proof');
    fixture = largePsFixture({ vanished: true });
    assert.deepEqual(await reader({ ...options, pids: [fixture.targetPid] }), new Map());
  }
});
