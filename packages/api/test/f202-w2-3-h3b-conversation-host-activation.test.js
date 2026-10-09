/**
 * F202 W2-3 h3b — a package hosts `cloud-conversation-host` for exactly as long as it is enabled
 * (ledger「h3b 实现设计」, codex design review …000912).
 *
 * The declared runtime contributions register it as the provider's holder as the last step of the
 * activation and unregister it before its carrier stops. Every lease is new: a package enabled
 * again is a new holder, and an old lease can never remove a newer one. A package that could not
 * serve fails to enable (and is stopped again) instead of failing the owner's first message: a
 * second package for a provider that already has one, a missing grant, a declared action the
 * module does not expose, a Host composed without a registry (production until h3c), or a carrier
 * other than the in-process module.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { CloudConversationHostRegistry } from '../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { PluginLifecycleError } from '../dist/domains/plugin/index.js';
import { cleanup, conversationHostHarness, hostManifest, METHODS } from './f202-w2-3-h3b.fixture.js';

after(cleanup);

const startFailed = (error) => error instanceof PluginLifecycleError && error.code === 'START_FAILED';

test('the fixture package is what the contract accepts', () => {
  assert.equal(validateManifest(hostManifest()).valid, true);
});

test('enabling makes the package the provider holder; disabling releases it; each enable is a new lease', async () => {
  const h = await conversationHostHarness();
  assert.equal(h.registry.current('chatgpt'), undefined);

  await h.enable();
  const first = h.registry.current('chatgpt');
  assert.equal(first.pluginInstanceId, h.instances[0]);
  assert.equal(first.pluginId, 'dev.clowder.h3b-host');
  assert.equal(first.contribution.appendMessage.method, METHODS.append);

  let heldWhileStopping;
  h.script.stop = () => {
    heldWhileStopping = h.registry.current('chatgpt');
  };
  await h.disable();
  assert.equal(heldWhileStopping, undefined, 'the provider is released before the module stops');
  assert.equal(h.registry.current('chatgpt'), undefined);

  await h.enable();
  const second = h.registry.current('chatgpt');
  assert.notEqual(second, first);
  assert.ok(second.generation > first.generation);
  assert.equal(h.registry.isCurrent(first), false);
  h.registry.unregister(first);
  assert.equal(h.registry.current('chatgpt'), second, 'an old lease never removes a newer holder');
});

test('a second package for the same provider fails to enable, is stopped again, and the first keeps it', async () => {
  const h = await conversationHostHarness({
    packages: [{ manifest: hostManifest() }, { manifest: hostManifest({ pluginId: 'dev.clowder.h3b-rival' }) }],
  });
  await h.enable(h.instances[0]);
  const holder = h.registry.current('chatgpt');

  await assert.rejects(h.enable(h.instances[1]), startFailed);

  assert.equal(h.registry.current('chatgpt'), holder);
  assert.deepEqual(
    h
      .calls()
      .filter((call) => call.pluginId === 'dev.clowder.h3b-rival')
      .map((call) => call.reason ?? call.method),
    ['start', 'start_failed'],
  );
});

test('a package that could not serve fails to enable and is stopped again, holding nothing', async (t) => {
  const cases = {
    'the owner did not grant cloud.conversation.host': { packages: [{ manifest: hostManifest(), grants: [] }] },
    'the module does not expose a declared action': {
      packages: [{ manifest: hostManifest(), exposes: [METHODS.append, METHODS.list] }],
    },
    'the Host has no registry (production until h3c)': { withRegistry: false },
  };
  for (const [name, options] of Object.entries(cases)) {
    await t.test(name, async () => {
      const h = await conversationHostHarness(options);

      await assert.rejects(h.enable(), startFailed);

      assert.equal(h.registry.current('chatgpt'), undefined);
      assert.deepEqual(
        h.calls().map((call) => call.reason ?? call.method),
        ['start', 'start_failed'],
      );
      assert.equal(h.calls(METHODS.append).length, 0);
    });
  }
});

function contributionsWith(registry) {
  return new DeclaredRuntimeContributions({
    packages: { resolveInstalledPackage: async () => assert.fail('no package files are read') },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    cloudConversationHosts: registry,
  });
}

function admission(manifest) {
  return {
    instance: { pluginInstanceId: 'pi_unit' },
    packageRecord: { pluginId: manifest.pluginId, manifest },
    effectiveGrants: ['cloud.conversation.host'],
  };
}

const surface = {
  attempt: async () => ({ status: 'returned', value: undefined }),
  exposes: async () => true,
};

test('only an in-process module can host a cloud conversation for now', async () => {
  const registry = new CloudConversationHostRegistry();
  const stdio = hostManifest({ runtime: { transport: 'stdio', entrypoint: 'dist/plugin.js' } });

  await assert.rejects(
    contributionsWith(registry).activate(admission(stdio), async () => undefined, surface),
    (error) => error?.code === 'UNSUPPORTED_TRANSPORT' && /in-process module/.test(error.message),
  );
  assert.equal(registry.current('chatgpt'), undefined);
});

test('without the action surface a declaration is refused, and a refused activation leaves no lease', async () => {
  const registry = new CloudConversationHostRegistry();
  const contributions = contributionsWith(registry);

  await assert.rejects(
    contributions.activate(admission(hostManifest()), async () => undefined),
    {
      code: 'UNSUPPORTED_TRANSPORT',
    },
  );
  assert.equal(registry.current('chatgpt'), undefined);

  await contributions.activate(admission(hostManifest()), async () => undefined, surface);
  assert.equal(registry.current('chatgpt').pluginInstanceId, 'pi_unit');
  contributions.deactivate('pi_unit');
  assert.equal(registry.current('chatgpt'), undefined);
});

test('the registry tells its listeners about every change, and stops when unsubscribed', () => {
  const registry = new CloudConversationHostRegistry();
  const seen = [];
  const unsubscribe = registry.subscribe(() => seen.push(registry.current('chatgpt')?.pluginId ?? null));
  const registration = {
    provider: 'chatgpt',
    pluginId: 'dev.clowder.a',
    pluginInstanceId: 'pi_a',
    contribution: hostManifest().contributions[0],
    attempt: surface.attempt,
  };

  const lease = registry.register(registration);
  assert.throws(() => registry.register({ ...registration, pluginId: 'dev.clowder.b' }), {
    code: 'RUNTIME_ALREADY_ACTIVE',
  });
  registry.unregister(lease);
  registry.unregister(lease);
  unsubscribe();
  registry.register(registration);

  assert.deepEqual(seen, ['dev.clowder.a', null]);
});
