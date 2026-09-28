import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { inspectPersonalChromePluginState } from '../scripts/f247-personal-chrome-install.mjs';
import { authorizePersonalChromeConversation } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import {
  inspectNativeHostInstallation,
  installNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import { NATIVE_HOST_ARTIFACT_FILES } from '../src/plugins/cloud-cat-personal-host/native-host/native-host-artifact.mjs';
import { renderNativeHostLauncher } from '../src/plugins/cloud-cat-personal-host/native-host/native-host-install-contract.mjs';
import {
  readPersonalChromePairingRecord,
  resolvePersonalChromeHostPaths,
  writePersonalChromePairingRecordAtomic,
} from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';

async function fixture(t, legacy = true) {
  const root = await mkdtemp(join(tmpdir(), 'f247-legacy-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    platform: 'darwin',
    projectRoot: join(root, 'project'),
    homeDirectory: join(root, 'home'),
    extensionId: 'a'.repeat(32),
  };
  await installNativeHost(options);
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  let record = await readPersonalChromePairingRecord(paths.pairingRecordPath);
  let directory = join(paths.artifactsDirectory, record.artifactDigest.slice(7));
  if (legacy) {
    // The pre-title release had these nine members. Its own pinned digest,
    // rather than the new release's member list, defines installation integrity.
    const files = NATIVE_HOST_ARTIFACT_FILES.filter((name) => !name.startsWith('conversation-title'));
    const bytes = await Promise.all(files.map((name) => readFile(join(directory, name))));
    const digest = createHash('sha512');
    files.forEach((name, index) => {
      digest.update(name).update(Buffer.of(0)).update(bytes[index]).update(Buffer.of(0));
    });
    record = { ...record, artifactDigest: `sha512:${digest.digest('hex')}` };
    directory = join(paths.artifactsDirectory, record.artifactDigest.slice(7));
    await mkdir(directory, { mode: 0o700 });
    await Promise.all(files.map((name, index) => writeFile(join(directory, name), bytes[index], { mode: 0o600 })));
    await writePersonalChromePairingRecordAtomic(paths.pairingRecordPath, record);
    await writeFile(
      paths.launcherPath,
      renderNativeHostLauncher({
        nodeExecutable: process.execPath,
        artifactEntrypoint: join(directory, 'native-host-cli.mjs'),
        pairingRecordPath: paths.pairingRecordPath,
      }),
      { mode: 0o700 },
    );
  }
  const stamp = '2026-09-04T22:26:00.000Z';
  await authorizePersonalChromeConversation(paths.conversationBindingPath, {
    conversationId: 'existing-conversation',
    chatUrl: 'https://chatgpt.com/c/existing-conversation',
    authorizedAt: stamp,
    updatedAt: stamp,
  });
  const inspect = () =>
    inspectPersonalChromePluginState({
      ...options,
      inspectInstallation: () => inspectNativeHostInstallation(options),
      probeLive: async () => ({ status: 'stale_adapter', errorCode: 'STALE_HELPER' }),
    });
  return { options, paths, record, directory, inspect };
}

test('an intact older artifact is stale and repairable, retaining the original grant and pairing', async (t) => {
  const f = await fixture(t);
  const grant = await readFile(f.paths.conversationBindingPath, 'utf8');
  await assert.rejects(inspectNativeHostInstallation(f.options), { code: 'NATIVE_HOST_ARTIFACT_STALE' });
  const state = await f.inspect();
  assert.equal(state.artifact.helper, 'stale');
  assert.equal(state.authorization.count, 1);
  assert.equal(state.live.status, 'stale_adapter');
  assert.equal((await installNativeHost(f.options)).operation, 'repaired');
  const repaired = await readPersonalChromePairingRecord(f.paths.pairingRecordPath);
  assert.equal(repaired.pairingSecret, f.record.pairingSecret);
  assert.equal(repaired.installedAt, f.record.installedAt);
  assert.equal(await readFile(f.paths.conversationBindingPath, 'utf8'), grant);
  assert.equal((await inspectNativeHostInstallation(f.options)).status, 'ready');
});

for (const damage of ['missing', 'tampered', 'extra', 'symlink']) {
  test(`a recorded artifact with ${damage} content is invalid, never absent or valid-stale`, async (t) => {
    const f = await fixture(t, false);
    const path = join(f.directory, 'native-host-cli.mjs');
    if (damage === 'missing' || damage === 'symlink') await rm(path);
    if (damage === 'tampered') await writeFile(path, 'tampered');
    if (damage === 'extra') await writeFile(join(f.directory, 'unexpected.mjs'), 'extra');
    if (damage === 'symlink') await symlink(join(f.directory, 'native-host.mjs'), path);
    assert.equal((await f.inspect()).artifact.helper, 'invalid');
  });
}

test(
  'a named pipe inside a recorded artifact is rejected without blocking inspection',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t, false);
    const path = join(f.directory, 'native-host-cli.mjs');
    await rm(path);
    await promisify(execFile)('mkfifo', [path]);
    const moduleUrl = new URL(
      '../src/plugins/cloud-cat-personal-host/native-host/native-host-artifact.mjs',
      import.meta.url,
    ).href;
    const probe =
      'const { digestInstalledNativeHostArtifactDirectory: digest } = await import(process.argv[1]); try { await digest(process.argv[2]); process.exitCode=2; } catch { process.stdout.write("invalid"); }';
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', probe, moduleUrl, f.directory],
      { timeout: 1000, killSignal: 'SIGKILL' },
    );
    assert.equal(stdout, 'invalid');
  },
);
