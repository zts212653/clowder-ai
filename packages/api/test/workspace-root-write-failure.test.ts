import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  linkedRootConfigPath,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { removeLinkedRoot } from '../src/domains/workspace/roots/workspace-linked-roots.js';
import { connectWorkspaceRoot } from '../src/domains/workspace/roots/workspace-root-connection.js';
import {
  issueRootConnectionProof,
  verifyRootConnectionProof,
} from '../src/domains/workspace/roots/workspace-root-proof.js';
import { rootStoreFixture } from './helpers/workspace-root-store-fixture.js';

type Stage = 'file-flush' | 'rename' | 'directory-open' | 'directory-flush';
function injectFailure(t: TestContext, target: string, stage: Stage) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const close = fs.closeSync;
  const rename = fs.renameSync;
  const error = Object.assign(new Error(`injected ${stage}`), {
    code: stage.startsWith('directory') ? 'EIO' : 'EPERM',
  });
  const directoryFd = 1_000_000;
  let fileFd = -1;
  let closedDirectory = false;
  // A Unix branch contract on every OS; native cold-store tests use no IO mocks.
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === dirname(target) && args[1] === 'r') {
      if (stage === 'directory-open') throw error;
      return directoryFd;
    }
    const fd = open(...args);
    if (String(args[0]).startsWith(`${target}.`) && args[1] === 'wx') fileFd = fd;
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if ((stage === 'file-flush' && fd === fileFd) || (stage === 'directory-flush' && fd === directoryFd)) throw error;
    if (fd !== directoryFd) sync(fd);
  });
  t.mock.method(fs, 'closeSync', (fd: number) => {
    if (fd === directoryFd) closedDirectory = true;
    else close(fd);
  });
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target && stage === 'rename') throw error;
    rename(from, to);
  });
  syncBuiltinESMExports();
  return {
    error,
    closedDirectory: () => closedDirectory,
    restore() {
      Object.defineProperty(process, 'platform', platform);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

for (const stage of ['file-flush', 'rename', 'directory-open', 'directory-flush'] as const) {
  test(`key ${stage} failure preserves the published identity and permits retry`, async (t) => {
    const root = await rootStoreFixture(t);
    const key = join(dirname(linkedRootConfigPath()), 'secrets', 'root-preparation.key');
    const claims = { userId: 'operator', root, expectedEpoch: 0, source: { kind: 'directory-selection' as const } };
    const injection = injectFailure(t, key, stage);
    const published = stage.startsWith('directory');
    let before: string | undefined;
    try {
      assert.throws(
        () => issueRootConnectionProof(claims),
        (error) => error === injection.error,
      );
      assert.equal(fs.existsSync(key), published);
      if (published) before = createHash('sha256').update(fs.readFileSync(key)).digest('hex');
      assert.equal(
        fs.readdirSync(dirname(key)).some((name) => name.endsWith('.tmp')),
        false,
      );
      if (stage === 'directory-flush') assert.equal(injection.closedDirectory(), true);
    } finally {
      injection.restore();
    }
    const proof = issueRootConnectionProof(claims);
    assert.deepEqual(verifyRootConnectionProof(proof), claims);
    if (before) assert.equal(createHash('sha256').update(fs.readFileSync(key)).digest('hex'), before);
    const helper = fileURLToPath(new URL('./helpers/workspace-root-proof-child.ts', import.meta.url));
    const verified = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), helper],
        { env: process.env, timeout: 20000 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
      assert.ok(child.stdin);
      child.stdin.end(proof);
    });
    assert.deepEqual(JSON.parse(verified), claims);
    assert.equal(readLinkedRootState().roots.length, 0);
  });

  test(`root ${stage} failure preserves JSON/receipt/epoch across retry and restart`, async (t) => {
    const root = await rootStoreFixture(t);
    const existing = await connectWorkspaceRoot('operator', 'existing', root, 0);
    const target = linkedRootConfigPath();
    const before = fs.readFileSync(target, 'utf8');
    const selected = join(root, 'selected');
    await mkdir(selected);
    const injection = injectFailure(t, target, stage);
    const published = stage.startsWith('directory');
    try {
      await assert.rejects(connectWorkspaceRoot('operator', 'new', selected, 0), (error) => error === injection.error);
      assert.equal(readLinkedRootState().operations.length, published ? 2 : 1);
      if (!published) assert.equal(fs.readFileSync(target, 'utf8'), before);
      assert.equal(
        fs.readdirSync(dirname(target)).some((name) => name.endsWith('.tmp')),
        false,
      );
      if (stage === 'directory-flush') assert.equal(injection.closedDirectory(), true);
    } finally {
      injection.restore();
    }
    const committed = fs.readFileSync(target, 'utf8');
    const receipt = await connectWorkspaceRoot('operator', 'new', selected, 0);
    if (published) assert.equal(fs.readFileSync(target, 'utf8'), committed, 'replay must not rewrite committed JSON');
    assert.equal(receipt.currentEpoch, 1);
    assert.equal(readLinkedRootState().operations.length, 2);
    assert.equal(readLinkedRootState().roots.length, 2);
    assert.equal(await removeLinkedRoot(receipt.linked.id), true);
    const replay = await connectWorkspaceRoot('operator', 'new', selected, 0);
    assert.equal(replay.connected, false);
    assert.equal(replay.receiptRef, receipt.receiptRef);
    assert.equal(replay.currentEpoch, 2);
    const helper = fileURLToPath(new URL('./helpers/workspace-root-connection-child.ts', import.meta.url));
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), helper, 'read', 'new'],
      { env: process.env, timeout: 20000 },
    );
    assert.deepEqual(JSON.parse(result.stdout), replay);
    assert.equal(readLinkedRootState().roots[0]?.id, existing.linked.id);
  });
}

test('invalid and unreadable existing signing keys fail without replacement', async (t) => {
  const root = await rootStoreFixture(t);
  const claims = { userId: 'operator', root, expectedEpoch: 0, source: { kind: 'directory-selection' as const } };
  issueRootConnectionProof(claims);
  const path = join(dirname(linkedRootConfigPath()), 'secrets', 'root-preparation.key');
  fs.writeFileSync(path, 'invalid');
  assert.throws(() => issueRootConnectionProof(claims), /signing key is invalid/);
  assert.equal(fs.readFileSync(path, 'utf8'), 'invalid');
  const read = fs.readFileSync;
  const denied = Object.assign(new Error('key read denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === path) throw denied;
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => issueRootConnectionProof(claims),
      (error) => error === denied,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(path, 'utf8'), 'invalid');
});
