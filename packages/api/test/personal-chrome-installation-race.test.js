import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  inspectNativeHostInstallation,
  installNativeHost,
  uninstallNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import { writePersonalChromePairingRecordAtomic } from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';

const roots = new Set();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function testScope() {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-install-race-'));
  roots.add(root);
  return { projectRoot: join(root, 'project'), homeDirectory: join(root, 'home') };
}

function pausedPairingWriter() {
  let announceCommit;
  let releaseCommit;
  const commitStarted = new Promise((resolve) => {
    announceCommit = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  return {
    commitStarted,
    releaseCommit,
    async writePairingRecord(...args) {
      announceCommit();
      await commitGate;
      return writePersonalChromePairingRecordAtomic(...args);
    },
  };
}

describe('Personal Chrome Host installation concurrency', () => {
  it('serializes concurrent install transactions with a reclaimable process lease', async () => {
    const scope = await testScope();
    const pause = pausedPairingWriter();
    const first = installNativeHost({
      platform: 'darwin',
      ...scope,
      extensionId: 'g'.repeat(32),
      generatePairingSecret: () => 'u'.repeat(64),
      writePairingRecord: pause.writePairingRecord,
    });
    await pause.commitStarted;

    await assert.rejects(
      installNativeHost({ platform: 'darwin', ...scope, extensionId: 'g'.repeat(32) }),
      /installation already has a live owner/,
    );

    pause.releaseCommit();
    assert.equal((await first).status, 'ready');
  });

  it('does not let uninstall tear activation files out of an in-flight install', async () => {
    const scope = await testScope();
    const pause = pausedPairingWriter();
    const installing = installNativeHost({
      platform: 'darwin',
      ...scope,
      extensionId: 'h'.repeat(32),
      generatePairingSecret: () => 'v'.repeat(64),
      writePairingRecord: pause.writePairingRecord,
    });
    await pause.commitStarted;

    let rejectionAssertion;
    try {
      await assert.rejects(
        uninstallNativeHost({ platform: 'darwin', ...scope }),
        /installation already has a live owner/,
      );
    } catch (error) {
      rejectionAssertion = error;
    } finally {
      pause.releaseCommit();
    }
    assert.equal((await installing).status, 'ready');
    if (rejectionAssertion) throw rejectionAssertion;
    assert.equal((await inspectNativeHostInstallation({ platform: 'darwin', ...scope })).status, 'ready');
  });
});
