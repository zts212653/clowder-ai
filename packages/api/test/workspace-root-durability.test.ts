import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { test } from 'node:test';
import {
  linkedRootConfigPath,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { connectWorkspaceRoot } from '../src/domains/workspace/roots/workspace-root-connection.js';
import {
  issueRootConnectionProof,
  verifyRootConnectionProof,
} from '../src/domains/workspace/roots/workspace-root-proof.js';
import { rootStoreFixture } from './helpers/workspace-root-store-fixture.js';

test('Windows cold proof and root commit retain file flush/rename without opening directories', async (t) => {
  const root = await rootStoreFixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  const originalOpen = fs.openSync;
  const originalSync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  let filesFlushed = 0;
  let published = 0;
  let directoriesOpened = 0;
  let lastFile = -1;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[1] === 'r') {
      directoriesOpened++;
      throw Object.assign(new Error('Windows directory open/fsync unsupported'), { code: 'EPERM' });
    }
    assert.equal(args[1], 'wx');
    assert.equal(args[2], 0o600);
    lastFile = originalOpen(...args);
    return lastFile;
  });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    assert.ok(fs.fstatSync(fd).isFile());
    filesFlushed++;
    originalSync(fd);
  });
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    assert.equal(dirname(String(from)), dirname(String(to)));
    assert.equal(filesFlushed, published + 1, 'flush the file before publishing it');
    assert.throws(() => fs.fstatSync(lastFile), { code: 'EBADF' }, 'close the file before rename');
    originalRename(from, to);
    published++;
  });
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const claims = { userId: 'operator', root, expectedEpoch: 0, source: { kind: 'directory-selection' as const } };
    assert.deepEqual(verifyRootConnectionProof(issueRootConnectionProof(claims)), claims);
    const receipt = await connectWorkspaceRoot('operator', 'cold', root, 0);
    assert.equal(receipt.connected, true);
    assert.equal(readLinkedRootState().operations.length, 1);
    assert.equal(fs.existsSync(linkedRootConfigPath()), true);
    assert.equal(filesFlushed, 2);
    assert.equal(published, 2);
    assert.equal(directoriesOpened, 0);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
