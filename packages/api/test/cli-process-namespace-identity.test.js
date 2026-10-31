import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const moduleUrl = new URL('../dist/utils/cli-process-ownership.js', import.meta.url).href;
test('production sync/async readers and manifests retain namespace-zero coordinates without unsafe signals', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    let row;
    cp.spawnSync = () => ({ status: 0, stdout: row, stderr: '' });
    cp.execFile = (...args) => args.at(-1)(null, row, '');
    syncBuiltinESMExports();
    const m = await import(${JSON.stringify(moduleUrl)});
    for (const [pid, ppid, pgid, valid] of [[1,0,1,true],[40,1,0,true],[40,1,40,true],[0,1,1,false],[-1,1,1,false],[40,-1,1,false],[40,1,-1,false]]) {
      row = pid+' '+ppid+' '+pgid+' Wed Oct 14 18:00:00 2026 node';
      for (const snapshot of [m.readUnixProcessSnapshotSync(), await m.readUnixProcessSnapshot()]) assert.equal(snapshot.has(pid),valid, row);
      const identity = {pid,ppid,pgid,startedAt:'Wed Oct 14 18:00:00 2026'};
      const manifest = m.parseCliProcessOwnerManifest({v:1,ownerId:'12345678-1234-4234-8234-123456789abc',createdAt:1,supervisor:identity,root:identity});
      assert.equal(!!manifest,valid,row);
    }
    const target = {pid:40,ppid:0,pgid:0,startedAt:'birth'};
    const calls=[];
    m.signalOwnedUnixProcesses([target],new Map([[40,target]]),'SIGTERM',pid=>calls.push(pid));
    assert.deepEqual(calls,[40]);
    const invalid={...target,pid:0};
    m.signalOwnedUnixProcesses([invalid],new Map([[0,invalid]]),'SIGTERM',pid=>calls.push(pid));
    assert.deepEqual(calls,[40]);
    assert.equal(m.sameUnixProcess(target,{...target,startedAt:'other'}),false);
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
