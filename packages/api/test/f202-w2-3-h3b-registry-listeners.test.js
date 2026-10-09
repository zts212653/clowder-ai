/**
 * F202 W2-3 h3b — a registry listener that throws never breaks the lifecycle that changed the
 * registry (codex review of `21fb36302f`, Host thread …000945, P2).
 *
 * Listeners are told after the change is made. A listener that throws is reported through the
 * registry's error hook and skipped: the listeners after it are still told, `register` still
 * returns the lease it made (so a failing activation can release it, and a successful one is not
 * reported as failed), and `unregister` still returns normally (so the rest of the teardown —
 * schedules, limbs — runs). A failing error hook changes nothing either.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { CloudConversationHostRegistry } from '../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { cleanup, conversationHostHarness, hostManifest, tempRoot } from './f202-w2-3-h3b.fixture.js';

after(cleanup);

const failing = () => {
  throw new Error('listener failed');
};

const surface = {
  attempt: async () => ({ status: 'returned', value: undefined }),
  exposes: async () => true,
};

test('a failing listener is reported and skipped, and even a failing report leaves the change standing', () => {
  const registration = {
    provider: 'chatgpt',
    pluginId: 'dev.clowder.a',
    pluginInstanceId: 'pi_a',
    contribution: hostManifest().contributions[0],
    attempt: surface.attempt,
  };
  const reported = [];
  const hooks = {
    'a recording hook': (error, change) =>
      reported.push([change.kind, change.pluginId, change.generation, error.message]),
    'a hook that throws itself': () => {
      throw new Error('report failed');
    },
    'the default hook (the plugin log)': undefined,
  };
  for (const [name, onListenerError] of Object.entries(hooks)) {
    const registry = new CloudConversationHostRegistry(onListenerError ? { onListenerError } : undefined);
    const told = [];
    registry.subscribe(failing);
    registry.subscribe(() => told.push(registry.current('chatgpt')?.pluginId ?? null));

    const lease = registry.register(registration);
    assert.equal(registry.current('chatgpt'), lease, name);
    registry.unregister(lease);
    assert.equal(registry.current('chatgpt'), undefined, name);
    assert.deepEqual(told, ['dev.clowder.a', null], `${name}: the listener after the failing one is told`);
  }
  assert.deepEqual(reported, [
    ['registered', 'dev.clowder.a', 1, 'listener failed'],
    ['unregistered', 'dev.clowder.a', 1, 'listener failed'],
  ]);
});

test('a listener failing on register never leaves a failed activation holding the provider', async () => {
  const reported = [];
  const h = await conversationHostHarness({
    registryOptions: { onListenerError: (_error, change) => reported.push(change.kind) },
  });
  h.registry.subscribe(failing);

  await h.enable();
  assert.equal(h.registry.current('chatgpt')?.pluginInstanceId, h.instances[0], 'enabled, and it holds the provider');

  await h.disable();
  assert.equal(h.registry.current('chatgpt'), undefined);
  await h.enable();
  assert.equal(h.registry.current('chatgpt')?.pluginInstanceId, h.instances[0], 'nothing was left holding it');
  assert.deepEqual(reported, ['registered', 'unregistered', 'registered']);
});

test('a listener failing on release does not stop the rest of the teardown', async () => {
  const packageRoot = await tempRoot('f202-h3b-teardown-');
  await mkdir(join(packageRoot, 'limbs'), { recursive: true });
  await writeFile(
    join(packageRoot, 'limbs/fixture.yml'),
    [
      'nodeId: h3b-teardown-node',
      'displayName: Teardown node',
      'platform: fixture',
      'capabilities:',
      '  - cap: fixture.echo',
      '    authLevel: free',
      '    commands: [echo]',
      'commands:',
      '  echo:',
      '    type: invoke',
      '    description: teardown fixture',
      '    params: {}',
      '    handler: fixture.echo',
      '',
    ].join('\n'),
  );
  const base = hostManifest({ pluginId: 'dev.clowder.h3b-teardown' });
  const manifest = {
    ...base,
    contributions: [
      ...base.contributions,
      { type: 'limb', id: 'teardown-limb', manifestPath: 'limbs/fixture.yml' },
      {
        type: 'schedule',
        id: 'teardown-schedule',
        schedule: { kind: 'interval', everyMs: 60_000 },
        action: { method: 'fixture.tick' },
        policy: { overlap: 'skip', timeoutMs: 5_000 },
      },
    ],
  };
  const tasks = new Map();
  const limbRegistry = new LimbRegistry();
  const reported = [];
  const registry = new CloudConversationHostRegistry({
    onListenerError: (_error, change) => reported.push(change.kind),
  });
  const contributions = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    limbRegistry,
    taskRunner: {
      registerPostStart: (task) => tasks.set(task.id, task),
      unregister: (taskId) => tasks.delete(taskId),
    },
    cloudConversationHosts: registry,
  });
  const admission = {
    instance: { pluginInstanceId: 'pi_teardown' },
    packageRecord: { pluginId: manifest.pluginId, packageDigest: 'digest-teardown', manifest },
    effectiveGrants: ['cloud.conversation.host', 'schedule.register'],
  };

  await contributions.activate(admission, async () => ({ success: true }), surface);
  assert.equal(registry.current('chatgpt')?.pluginInstanceId, 'pi_teardown');
  assert.ok(limbRegistry.getNode('h3b-teardown-node'));
  assert.equal(tasks.size, 1);
  const told = [];
  registry.subscribe(failing);
  registry.subscribe(() => told.push(registry.current('chatgpt') ?? null));

  contributions.deactivate('pi_teardown');

  assert.equal(registry.current('chatgpt'), undefined);
  assert.equal(tasks.size, 0, 'the schedule is still unregistered');
  assert.equal(limbRegistry.getNode('h3b-teardown-node'), undefined, 'the limb is still deregistered');
  assert.deepEqual(told, [null], 'the listener after the failing one is told');
  assert.deepEqual(reported, ['unregistered']);
});
