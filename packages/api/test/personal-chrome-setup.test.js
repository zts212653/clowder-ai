import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';
import { PersonalChromeSetup } from '../dist/domains/plugin/manager/chrome-setup/personal-chrome-setup.js';
import { TRUSTED_CHROME_SETUP_DELIVERY as pin } from '../dist/domains/plugin/manager/chrome-setup/personal-chrome-setup-policy.js';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../dist/domains/plugin/operations/plugin-operation-routes.js';

const pluginId = 'official.companion.personal-chrome';
const instanceId = 'pi_chrome_setup_test';
const manifest = {
  pluginId,
  version: pin.version,
  contractVersion: '0.1.0',
  name: 'Chrome',
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  configuration: [],
  features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
};
const auth = {
  host: 'localhost:3814',
  origin: 'http://localhost:3814',
  'x-cat-cafe-user': process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner-user',
};

async function harness(t, { enabled = false, digest = pin.digest, run, resumeFails = false, materialize } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chrome-host-policy-')));
  const home = join(root, 'home');
  const packageRoot = join(root, 'package');
  await mkdir(home);
  await mkdir(join(packageRoot, 'extension'), { recursive: true });
  const key = Buffer.alloc(162, 7).toString('base64');
  await writeFile(join(packageRoot, 'extension/manifest.json'), JSON.stringify({ key }));
  const extensionId = createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (x) => String.fromCharCode(97 + parseInt(x, 16)));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => instanceId });
  await inventory.installPackage({
    manifest,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: pluginId,
  });
  const events = [];
  let enabling = true;
  const supervisor = {
    stop: async () => {
      events.push('stop');
    },
    start: async () => {
      events.push('start');
      if (!enabling && resumeFails) throw new Error('resume failed');
    },
  };
  const lifecycle = new ExternalPluginLifecycleService({ store, supervisor });
  await lifecycle.prepare(instanceId, 1);
  if (enabled) {
    await lifecycle.enable(instanceId, 2);
    await store.transaction((tx) => tx.instances.put({ ...tx.instances.get(instanceId), runtimeState: 'healthy' }));
  }
  enabling = false;
  events.length = 0;
  let released = 0;
  let verified = 0;
  let runs = 0;
  const result = (action, installed = action !== 'uninstall') => ({
    protocolVersion: 1,
    ok: true,
    action,
    installed,
    extensionPath: installed ? join(root, '.cat-cafe/plugin-host/personal-chrome-host/extension') : null,
    extensionId,
    browserAction: installed && action === 'install' ? 'load-unpacked' : 'none',
    restartRequired: installed && action === 'install',
  });
  const setup = new PersonalChromeSetup({
    inventory: store,
    lifecycle,
    projectRoot: root,
    home,
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {
          verified++;
        },
        release: async () => {
          released++;
          events.push('release');
        },
      }),
    },
    ...(materialize
      ? {
          materializer: {
            resolve: async (input) => {
              await materialize({ input, store });
              return {
                rootDir: packageRoot,
                manifest,
                verifyIntegrity: async () => {
                  verified++;
                },
                release: async () => {
                  released++;
                },
              };
            },
          },
        }
      : {}),
    run: async (input) => {
      runs++;
      events.push('run');
      assert.equal(input.home, home);
      assert.equal(input.projectRoot, root);
      assert.equal(input.entrypoint, join(packageRoot, 'native-host/setup-host.mjs'));
      return run ? run({ input, store, result, events }) : result(input.action);
    },
  });
  const configuration = new HostPluginConfigurationService({ inventory: store, projectRoot: root });
  const operations = new InstalledPluginOperations({
    inventory: store,
    personalChromeSetup: setup,
    configuration,
    invocation: {
      invoke: async () => {
        throw new Error('must not enter plugin carrier');
      },
    },
  });
  const app = Fastify();
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = request.headers['x-cat-cafe-user'];
  });
  await app.register(pluginOperationRoutes, { operations });
  t.after(() => app.close());
  const request = (action = 'inspect', headers = auth, payload = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/plugins/${pluginId}/actions/hostChromeSetup/${action}`,
      headers,
      payload,
      remoteAddress: '127.0.0.1',
    });
  return {
    root,
    home,
    store,
    inventory,
    operations,
    configuration,
    setup,
    events,
    request,
    counts: () => ({ released, verified, runs }),
    result,
  };
}

test('same policy projects and executes a Host operation without plugin manifest/module handlers', async (t) => {
  const h = await harness(t);
  const fields = await h.configuration.fields(pluginId);
  assert.deepEqual(
    fields[0].actions.map((x) => x.id),
    ['inspect', 'install', 'uninstall'],
  );
  const before = await h.store.snapshot();
  const r = await h.request();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().render, 'rows');
  assert.deepEqual(await h.store.snapshot(), before, 'inspect does not persist operation or lifecycle state');
  assert.equal(await h.configuration.readOperationState(pluginId, 'hostChromeSetup'), undefined);
  assert.deepEqual(manifest.configuration, []);
  assert.deepEqual(h.counts(), { runs: 1, verified: 2, released: 1 });
  assert.deepEqual(h.events, ['run', 'release']);
});

test('wrong digest of the same id/version has neither UI nor execution authority', async (t) => {
  const h = await harness(t, { digest: 'sha512-' + createHash('sha512').update('not-reviewed').digest('base64') });
  assert.deepEqual(await h.configuration.fields(pluginId), []);
  assert.equal((await h.request()).statusCode, 403);
  assert.equal(h.counts().runs, 0);
});

test('dependency preparation cannot bypass a changed owner installation fence', async (t) => {
  const h = await harness(t, {
    materialize: async ({ input, store }) => {
      assert.equal(input.pluginId, pluginId);
      assert.equal(input.packageDigest, pin.digest);
      assert.equal(input.pluginInstanceId, instanceId);
      await store.transaction((tx) => {
        const instance = tx.instances.get(instanceId);
        tx.instances.put({ ...instance, lifecycleRevision: instance.lifecycleRevision + 1 });
      });
    },
  });
  const result = await h.request('install', { ...auth, 'x-cat-cafe-owner-confirmed': 'true' });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().effect, 'not_started');
  assert.equal(h.counts().runs, 0);
  assert.equal(h.counts().released, 1);
});

test('owner context, declared action, confirmation and empty input are enforced at real route', async (t) => {
  const h = await harness(t);
  for (const headers of [{}, { ...auth, origin: 'https://evil.example' }])
    assert.ok([401, 403].includes((await h.request('inspect', headers)).statusCode));
  for (const action of ['install', 'uninstall']) {
    assert.equal((await h.request(action)).statusCode, 400);
    assert.equal((await h.request(action, { ...auth, 'x-cat-cafe-owner-confirmed': 'false' })).statusCode, 400);
  }
  for (const payload of [{ path: '/tmp/other' }, { command: 'open' }, { HOME: '/tmp/other' }])
    assert.equal((await h.request('inspect', auth, payload)).statusCode, 400);
  assert.equal((await h.request('unknown')).statusCode, 400);
  assert.equal((await h.operations.runAction(pluginId, 'hostChromeSetup', 'install', {})).status, 403);
  assert.equal(h.counts().runs, 0);
});

test('enabled runtime is stopped before runner, rebuilt fence accepts only stop revision, then resumed', async (t) => {
  const h = await harness(t, { enabled: true });
  const before = (await h.store.snapshot()).instances[0];
  const r = await h.request('install', { ...auth, 'x-cat-cafe-owner-confirmed': 'true' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(h.events, ['stop', 'run', 'release', 'start']);
  const after = (await h.store.snapshot()).instances[0];
  assert.equal(after.activationState, 'enabled');
  assert.ok(after.lifecycleRevision > before.lifecycleRevision);
  assert.equal(after.pluginInstanceId, before.pluginInstanceId);
  assert.equal(after.packageDigest, before.packageDigest);
});

test('completed mutation survives runtime recovery failure without rerunning it', async (t) => {
  const h = await harness(t, { enabled: true, resumeFails: true });
  const r = await h.request('install', { ...auth, 'x-cat-cafe-owner-confirmed': 'true' });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, 'SETUP_RUNTIME_RECOVERY_FAILED');
  assert.equal(r.json().effect, 'reported');
  assert.equal(r.json().setupResult.ok, true);
  assert.equal(h.counts().runs, 1);
  assert.equal(h.counts().released, 1);
});

for (const change of ['package', 'revision', 'manifest'])
  test(`fresh ${change} change fences runner result`, async (t) => {
    const h = await harness(t, {
      run: async ({ input, store, result }) => {
        await store.transaction((tx) => {
          const current = tx.instances.getCurrent(pluginId);
          if (change === 'manifest') {
            const pkg = tx.packages.get(current.packageDigest);
            tx.packages.put({ ...pkg, manifest: { ...pkg.manifest, name: 'changed' } });
          } else
            tx.instances.put({
              ...current,
              ...(change === 'package'
                ? { packageDigest: 'sha512-replaced' }
                : { lifecycleRevision: current.lifecycleRevision + 1 }),
            });
        });
        return result(input.action);
      },
    });
    const r = await h.request();
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(h.counts().released, 1);
  });

for (const defect of ['extensionId', 'action', 'extensionPath', 'crash'])
  test(`rejects runner ${defect}, retaining unknown-effect distinction`, async (t) => {
    const h = await harness(t, {
      run: ({ input, result }) => {
        if (defect === 'crash') throw new Error('crash private stderr');
        return { ...result(input.action), [defect]: defect === 'extensionId' ? 'a'.repeat(32) : 'wrong' };
      },
    });
    const r = await h.request('install', { ...auth, 'x-cat-cafe-owner-confirmed': 'true' });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().effect, 'unknown');
    assert.equal(h.counts().released, 1);
    assert.ok(!r.body.includes('private stderr'));
    assert.equal(h.counts().runs, 1);
  });
