import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withOwnerOperationRequest } from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { FilesystemVerifiedPluginPackageLocator } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  publishPluginPackageArchive,
} from '../dist/domains/plugin/index.js';
import { PersonalChromeSetup } from '../dist/domains/plugin/manager/chrome-setup/personal-chrome-setup.js';
import { TRUSTED_CHROME_SETUP_DELIVERY as pin } from '../dist/domains/plugin/manager/chrome-setup/personal-chrome-setup-policy.js';

const archive = process.env.F202_CHROME_SETUP_ARCHIVE;

test(
  'reviewed prepared bytes perform inspect/install/retry/uninstall in a fresh consumer HOME',
  {
    skip: !archive && 'Run the candidate gate with F202_CHROME_SETUP_ARCHIVE pointing to the exact prepared archive',
  },
  async () => {
    const bytes = await readFile(archive);
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pin.digest);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'chrome-setup-artifact-')));
    const home = join(root, 'home');
    await mkdir(home);
    const packagesRoot = join(root, 'packages');
    await publishPluginPackageArchive(packagesRoot, pin.digest, bytes);
    const packages = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
    const located = await packages.resolveInstalledPackage(pin.digest);
    const manifest = structuredClone(located.manifest);
    await located.release();
    assert.ok(!manifest.configuration.some((x) => x.key === 'hostChromeSetup'));
    const store = new MemoryPluginInventoryStore();
    const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_fresh_chrome' });
    await inventory.installPackage({
      manifest,
      computedPackageDigest: pin.digest,
      expectedPackageDigest: pin.digest,
      packagePluginId: manifest.pluginId,
      effectiveGrants: [],
    });
    const lifecycle = new ExternalPluginLifecycleService({
      store,
      supervisor: { start: async () => {}, stop: async () => {} },
    });
    await lifecycle.prepare('pi_fresh_chrome', 1);
    const setup = new PersonalChromeSetup({ inventory: store, lifecycle, packages, projectRoot: root, home });
    const invoke = (action) =>
      withOwnerOperationRequest(
        {
          pluginId: manifest.pluginId,
          operationKey: 'hostChromeSetup',
          actionId: action,
          userId: 'isolated-owner',
          requestId: `request-${action}`,
          confirmed: true,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        },
        () => setup.runAction(action, {}),
      );
    const before = await readdir(home);
    const inspected = await invoke('inspect');
    assert.equal(inspected.status, 200, JSON.stringify(inspected));
    assert.deepEqual(await readdir(home), before, 'inspect must not write HOME');
    const installed = await invoke('install');
    assert.equal(installed.status, 200, JSON.stringify(installed));
    const helperRoot = join(root, '.cat-cafe/plugin-host/personal-chrome-host');
    const paired = join(helperRoot, 'pairing.json');
    const pairingBefore = await readFile(paired, 'utf8');
    const retry = await invoke('install');
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(await readFile(paired, 'utf8'), pairingBefore);
    const authorizations = join(helperRoot, 'conversation-binding.json');
    await writeFile(authorizations, JSON.stringify({ fixture: 'retained-owner-authorizations' }));
    const removed = await invoke('uninstall');
    assert.equal(removed.status, 200, JSON.stringify(removed));
    await assert.rejects(readFile(paired), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(authorizations, 'utf8')).fixture, 'retained-owner-authorizations');
    assert.equal((await store.snapshot()).instances[0].pluginInstanceId, 'pi_fresh_chrome');
    // All filesystem manipulation in this test belongs to this fresh temp HOME.
    const registrationRoot =
      process.platform === 'darwin'
        ? join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
        : join(home, '.config/google-chrome/NativeMessagingHosts');
    await mkdir(registrationRoot, { recursive: true });
    const names = await readdir(registrationRoot);
    // The package's own runner refuses foreign registrations, not just the Host's wrapper.
    const nativeName = 'ai.catcafe.personal_cloud_cat_host.json';
    const registration = join(registrationRoot, names[0] ?? nativeName);
    await writeFile(registration, '{"name":"foreign","path":"/foreign"}');
    const foreign = await invoke('install');
    assert.equal(foreign.status, 409, JSON.stringify(foreign));
    if (process.platform === 'darwin') {
      const home2 = join(root, 'symlink-home');
      const outside = join(root, 'symlink-target');
      await mkdir(home2);
      await mkdir(outside);
      await symlink(outside, join(home2, 'Library'));
      const guarded = new PersonalChromeSetup({
        inventory: store,
        lifecycle,
        packages,
        projectRoot: root,
        home: home2,
      });
      const rejected = await withOwnerOperationRequest(
        {
          pluginId: manifest.pluginId,
          operationKey: 'hostChromeSetup',
          actionId: 'install',
          userId: 'isolated-owner',
          requestId: 'symlink',
          confirmed: true,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        },
        () => guarded.runAction('install', {}),
      );
      assert.equal(rejected.status, 409, JSON.stringify(rejected));
      assert.deepEqual(await readdir(outside), []);
    }
  },
);
