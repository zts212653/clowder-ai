import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installApiObserverBridge } from './installed-api-observer-bridge.mjs';

const require = createRequire(import.meta.url);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f330-observer-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  const state = path.join(root, 'state');
  const evidence = path.join(root, 'evidence');
  for (const directory of [install, path.join(state, 'project'), evidence])
    fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(install, 'desktop');
  const nativeNode = path.join(install, 'node');
  const apiEntry = path.join(install, 'index.js');
  const preload = path.join(root, 'observer.cjs');
  for (const file of [executable, nativeNode, apiEntry, preload]) fs.writeFileSync(file, 'fixture');
  const digest = createHash('sha256').update('fixture').digest('hex');
  const config = {
    expectedPid: 1234,
    executable,
    install,
    state,
    evidence,
    nativeNode,
    apiEntry,
    preload,
    sources: [{ path: preload, sha256: digest }],
    output: path.join(evidence, 'observer.jsonl'),
    receipt: path.join(evidence, 'observer-bridge.json'),
  };
  const calls = [];
  const sentinel = { pid: 5678 };
  const childProcess = {
    spawn(...args) {
      calls.push({ receiver: this, args });
      return sentinel;
    },
  };
  const host = {
    pid: 1234,
    type: 'browser',
    execPath: executable,
    platform: process.platform,
    getBuiltinModule: (name) => (name === 'node:child_process' ? childProcess : require(name)),
  };
  const options = {
    cwd: path.join(state, 'project'),
    env: { CAT_CAFE_DESKTOP_INSTANCE_ROOT: state, KEEP: 'same' },
    stdio: 'pipe',
  };
  return { config, host, childProcess, calls, sentinel, options };
}

test('only the exact owned API child receives one preload, preserving spawn result and other arguments', (t) => {
  const f = fixture(t);
  const installed = installApiObserverBridge(f.config, f.host);
  assert.equal(installed.installed, true);
  const args = ['--import', 'original-probe.mjs', f.config.apiEntry];
  const before = structuredClone(f.options);
  assert.equal(f.childProcess.spawn(f.config.nativeNode, args, f.options), f.sentinel);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].receiver, f.childProcess);
  assert.deepEqual(f.calls[0].args[1], ['--require', f.config.preload, ...args]);
  assert.deepEqual(f.calls[0].args[2], {
    ...f.options,
    env: { ...f.options.env, CAT_CAFE_WINDOWS_PRIVATE_OBSERVER_OUTPUT: f.config.output },
  });
  assert.deepEqual(f.options, before);
  assert.equal(JSON.parse(fs.readFileSync(f.config.receipt)).apiPid, 5678);
  assert.throws(() => f.childProcess.spawn(f.config.nativeNode, args, f.options), /already observed/);
  assert.equal(f.calls.length, 1);
});

test('unrelated subprocesses are passed through byte for byte without diagnostics', (t) => {
  const f = fixture(t);
  installApiObserverBridge(f.config, f.host);
  const args = ['different-entry.js'];
  assert.equal(f.childProcess.spawn(f.config.nativeNode, args, f.options), f.sentinel);
  assert.equal(f.calls[0].args[1], args);
  assert.equal(f.calls[0].args[2], f.options);
  assert.equal(fs.existsSync(f.config.receipt), false);
});

for (const kind of ['pid', 'executable', 'digest', 'output', 'receipt', 'state']) {
  test(`rejects ${kind} mismatch before spawning`, (t) => {
    const f = fixture(t);
    if (kind === 'pid') f.config.expectedPid += 1;
    if (kind === 'executable') f.config.executable = f.config.nativeNode;
    if (kind === 'digest') f.config.sources[0].sha256 = '0'.repeat(64);
    if (kind === 'output') f.config.output = path.join(f.config.install, 'observer.jsonl');
    if (kind === 'receipt') fs.writeFileSync(f.config.receipt, 'old evidence');
    if (kind === 'state') {
      installApiObserverBridge(f.config, f.host);
      f.options.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = path.dirname(f.config.state);
      assert.throws(() => f.childProcess.spawn(f.config.nativeNode, [f.config.apiEntry], f.options));
    } else assert.throws(() => installApiObserverBridge(f.config, f.host));
    assert.equal(f.calls.length, 0);
  });
}
