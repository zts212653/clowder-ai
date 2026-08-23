import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { writePersonalChromeConversationAuthorizationsAtomic } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import {
  inspectNativeHostInstallation,
  installNativeHost,
  uninstallNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import {
  readPersonalChromePairingRecord,
  redactPersonalChromePairingRecord,
  resolvePersonalChromeHostPaths,
  validatePersonalChromePairingRecord,
  writePersonalChromePairingRecordAtomic,
} from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';

const roots = new Set();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function testRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-install-'));
  roots.add(root);
  return root;
}

function pairingRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    extensionId: 'a'.repeat(32),
    socketPath: '/tmp/cat-cafe-personal-chrome/helper.sock',
    ledgerPath: '/tmp/cat-cafe-personal-chrome/delivery-ledger.json',
    pairingSecret: 's'.repeat(64),
    artifactDigest: `sha512:${'0'.repeat(128)}`,
    installedAt: '2026-08-12T23:00:00.000Z',
    updatedAt: '2026-08-12T23:00:00.000Z',
    ...overrides,
  };
}

describe('Personal Chrome Host installation state', () => {
  it('resolves one canonical Host-owned root beneath the plugin runtime', () => {
    const paths = resolvePersonalChromeHostPaths('/srv/cat-cafe');
    assert.deepEqual(paths, {
      rootDirectory: resolve('/srv/cat-cafe/.cat-cafe/plugin-host/personal-chrome-host'),
      artifactsDirectory: resolve('/srv/cat-cafe/.cat-cafe/plugin-host/personal-chrome-host/artifacts'),
      pairingRecordPath: resolve('/srv/cat-cafe/.cat-cafe/plugin-host/personal-chrome-host/pairing.json'),
      conversationBindingPath: resolve(
        '/srv/cat-cafe/.cat-cafe/plugin-host/personal-chrome-host/conversation-binding.json',
      ),
      launcherPath: resolve('/srv/cat-cafe/.cat-cafe/plugin-host/personal-chrome-host/native-host-launcher.mjs'),
      socketPath: paths.socketPath,
      ledgerPath: resolve('/srv/cat-cafe/.cat-cafe/plugin-host/personal-chrome-host/delivery-ledger.json'),
    });
    assert.match(paths.socketPath, /^\/tmp\/cat-cafe-f247-[a-f0-9]{24}\.sock$/);
    assert.ok(Buffer.byteLength(paths.socketPath) < 100);
  });

  it('rejects malformed, relative, weak-secret, and unknown-field records', () => {
    assert.throws(
      () => validatePersonalChromePairingRecord(pairingRecord({ extensionId: 'z'.repeat(32) })),
      /extensionId/,
    );
    assert.throws(
      () => validatePersonalChromePairingRecord(pairingRecord({ socketPath: 'relative.sock' })),
      /socketPath/,
    );
    assert.throws(
      () => validatePersonalChromePairingRecord(pairingRecord({ pairingSecret: 'too-short' })),
      /pairingSecret/,
    );
    assert.throws(() => validatePersonalChromePairingRecord({ ...pairingRecord(), extra: true }), /unknown field/);
  });

  it('atomically writes and replaces a mode-0600 record without leaking temp files', async () => {
    const root = await testRoot();
    const path = join(root, 'state', 'pairing.json');
    const first = pairingRecord();
    const second = pairingRecord({ updatedAt: '2026-08-12T23:01:00.000Z' });

    await writePersonalChromePairingRecordAtomic(path, first);
    assert.deepEqual(await readPersonalChromePairingRecord(path), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'state'))).mode & 0o077, 0);

    await writePersonalChromePairingRecordAtomic(path, second);
    assert.deepEqual(await readPersonalChromePairingRecord(path), second);
    assert.deepEqual(await readdir(join(root, 'state')), ['pairing.json']);
  });

  it('fails closed when a persisted record is group/world-readable', async () => {
    const root = await testRoot();
    const path = join(root, 'pairing.json');
    await writePersonalChromePairingRecordAtomic(path, pairingRecord());
    await chmod(path, 0o644);
    await assert.rejects(readPersonalChromePairingRecord(path), /mode 0600/);
  });

  it('projects install truth without serializing the pairing secret', () => {
    const secret = 'secret-value'.repeat(6);
    const projected = redactPersonalChromePairingRecord(pairingRecord({ pairingSecret: secret }));
    assert.deepEqual(projected, {
      schemaVersion: 1,
      extensionId: 'a'.repeat(32),
      socketPath: '/tmp/cat-cafe-personal-chrome/helper.sock',
      ledgerPath: '/tmp/cat-cafe-personal-chrome/delivery-ledger.json',
      artifactDigest: `sha512:${'0'.repeat(128)}`,
      installedAt: '2026-08-12T23:00:00.000Z',
      updatedAt: '2026-08-12T23:00:00.000Z',
      hasPairingSecret: true,
    });
    assert.doesNotMatch(JSON.stringify(projected), new RegExp(secret));
  });

  it('installs, repairs, inspects, and uninstalls an exact secret-safe native host', async () => {
    const root = await testRoot();
    const projectRoot = join(root, 'project');
    const homeDirectory = join(root, 'home');
    const extensionId = 'b'.repeat(32);
    const installedAt = '2026-08-12T23:10:00.000Z';

    const first = await installNativeHost({
      platform: 'darwin',
      projectRoot,
      homeDirectory,
      extensionId,
      now: () => new Date(installedAt),
      generatePairingSecret: () => 'p'.repeat(64),
    });
    assert.equal(first.status, 'ready');
    assert.equal(first.extensionId, extensionId);
    assert.equal(first.hasPairingSecret, true);
    assert.doesNotMatch(JSON.stringify(first), /p{32}/);
    assert.equal((await stat(first.pairingRecordPath)).mode & 0o777, 0o600);
    assert.notEqual((await stat(first.launcherPath)).mode & 0o111, 0);
    assert.equal((await stat(first.manifestPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(first.manifestPath, 'utf8')).path, first.launcherPath);

    const paths = resolvePersonalChromeHostPaths(projectRoot);
    await writePersonalChromeConversationAuthorizationsAtomic(paths.conversationBindingPath, {
      schemaVersion: 2,
      provider: 'chatgpt',
      conversations: [
        {
          conversationId: 'conversation-7',
          chatUrl: 'https://chatgpt.com/c/conversation-7',
          authorizedAt: installedAt,
          updatedAt: installedAt,
        },
      ],
      updatedAt: installedAt,
    });

    const repaired = await installNativeHost({
      platform: 'darwin',
      projectRoot,
      homeDirectory,
      extensionId,
      now: () => new Date('2026-08-12T23:11:00.000Z'),
      generatePairingSecret: () => 'q'.repeat(64),
    });
    assert.equal(repaired.status, 'ready');
    assert.equal(repaired.operation, 'unchanged');
    assert.deepEqual(await readPersonalChromePairingRecord(first.pairingRecordPath), {
      ...pairingRecord({
        extensionId,
        socketPath: first.socketPath,
        ledgerPath: first.ledgerPath,
        pairingSecret: 'p'.repeat(64),
        artifactDigest: first.artifactDigest,
        installedAt,
        updatedAt: installedAt,
      }),
    });

    assert.deepEqual(await inspectNativeHostInstallation({ platform: 'darwin', projectRoot, homeDirectory }), {
      ...first,
      operation: 'inspect',
    });

    const removed = await uninstallNativeHost({ platform: 'darwin', projectRoot, homeDirectory });
    assert.equal(removed.status, 'absent');
    await assert.rejects(access(first.manifestPath));
    await assert.rejects(access(first.launcherPath));
    await assert.rejects(access(first.pairingRecordPath));
    await assert.rejects(access(paths.conversationBindingPath));
    await access(first.artifactEntrypoint);
  });

  it('refuses to overwrite a Native Messaging manifest not owned by this installation', async () => {
    const root = await testRoot();
    const homeDirectory = join(root, 'home');
    const manifestPath = join(
      homeDirectory,
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.catcafe.personal_cloud_cat_host.json',
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({ name: 'someone.else', path: '/tmp/foreign-helper' })}\n`, {
      mode: 0o600,
    });

    await assert.rejects(
      installNativeHost({
        platform: 'darwin',
        projectRoot: join(root, 'project'),
        homeDirectory,
        extensionId: 'c'.repeat(32),
      }),
      /not owned/,
    );
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).path, '/tmp/foreign-helper');
  });

  it('does not claim a Windows install before registry activation exists', async () => {
    await assert.rejects(
      installNativeHost({
        platform: 'win32',
        projectRoot: 'C:\\CatCafe',
        homeDirectory: 'C:\\Users\\owner',
        localAppData: 'C:\\Users\\owner\\AppData\\Local',
        extensionId: 'c'.repeat(32),
      }),
      /registry activation.*not implemented/,
    );
  });

  it('keeps extension identity immutable until explicit uninstall', async () => {
    const root = await testRoot();
    const projectRoot = join(root, 'project');
    const homeDirectory = join(root, 'home');
    const first = await installNativeHost({
      platform: 'darwin',
      projectRoot,
      homeDirectory,
      extensionId: 'd'.repeat(32),
      generatePairingSecret: () => 'r'.repeat(64),
    });
    const manifestBefore = await readFile(first.manifestPath, 'utf8');
    const pairingBefore = await readFile(first.pairingRecordPath, 'utf8');

    await assert.rejects(
      installNativeHost({
        platform: 'darwin',
        projectRoot,
        homeDirectory,
        extensionId: 'e'.repeat(32),
      }),
      /identity is immutable/,
    );

    assert.equal(await readFile(first.manifestPath, 'utf8'), manifestBefore);
    assert.equal(await readFile(first.pairingRecordPath, 'utf8'), pairingBefore);
  });

  it('rolls activation files back when a repair cannot commit the pairing generation', async () => {
    const root = await testRoot();
    const projectRoot = join(root, 'project');
    const homeDirectory = join(root, 'home');
    const sourceDirectory = resolve('src/plugins/cloud-cat-personal-host/native-host');
    const changedSourceDirectory = join(root, 'changed-source');
    await mkdir(changedSourceDirectory, { recursive: true });
    for (const filename of await readdir(sourceDirectory)) {
      const sourcePath = join(sourceDirectory, filename);
      if ((await stat(sourcePath)).isFile())
        await writeFile(join(changedSourceDirectory, filename), await readFile(sourcePath));
    }
    await writeFile(
      join(changedSourceDirectory, 'native-results.mjs'),
      `${await readFile(join(changedSourceDirectory, 'native-results.mjs'), 'utf8')}\n// repair generation\n`,
    );

    const first = await installNativeHost({
      platform: 'darwin',
      projectRoot,
      homeDirectory,
      extensionId: 'f'.repeat(32),
      generatePairingSecret: () => 't'.repeat(64),
    });
    const launcherBefore = await readFile(first.launcherPath);
    const manifestBefore = await readFile(first.manifestPath);
    const pairingBefore = await readFile(first.pairingRecordPath);

    await assert.rejects(
      installNativeHost({
        platform: 'darwin',
        projectRoot,
        homeDirectory,
        extensionId: 'f'.repeat(32),
        sourceDirectory: changedSourceDirectory,
        writePairingRecord: async () => {
          throw new Error('simulated pairing commit failure');
        },
      }),
      /simulated pairing commit failure/,
    );

    assert.deepEqual(await readFile(first.launcherPath), launcherBefore);
    assert.deepEqual(await readFile(first.manifestPath), manifestBefore);
    assert.deepEqual(await readFile(first.pairingRecordPath), pairingBefore);
    assert.equal(
      (await inspectNativeHostInstallation({ platform: 'darwin', projectRoot, homeDirectory })).status,
      'ready',
    );
  });
});
