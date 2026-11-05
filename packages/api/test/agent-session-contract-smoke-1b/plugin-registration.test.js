// Plugin registration shares one provider per cat and refreshes it on re-registration.
//
// The registry entry is a ref (`plugin:<pluginId>/<declaration.id>`), but the
// provider object is created by Host code and must be shared per cat: one cat
// must never end up with two provider instances for the same declaration, and
// re-registering must hand out a fresh object.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { registerPluginAgentProvider } from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider-registration.js';

const DECLARATION = {
  id: 'intranet-agent',
  transport: 'acp',
  acp: { command: 'node', startupArgs: ['serve'] },
};

function register(registry, { pluginId = 'acme', declaration = DECLARATION, createProvider } = {}) {
  const created = [];
  const result = registerPluginAgentProvider(registry, {
    pluginId,
    declaration,
    createProvider:
      createProvider ??
      ((received, ctx) => {
        const provider = { declaration: received, catId: ctx.catId, instance: created.length };
        created.push(provider);
        return provider;
      }),
  });
  return { ...result, created };
}

test('[36] the key is plugin:<pluginId>/<declaration.id>', () => {
  const registry = new SessionImplementationRegistry();
  const { key } = register(registry);

  assert.equal(key, 'plugin:acme/intranet-agent');
  assert.equal(
    registry.has({ pluginId: 'acme', contributionId: 'intranet-agent' }),
    true,
    'the ref must be { pluginId, contributionId: declaration.id }',
  );
});

test('[36] one catId resolves to one provider object and one createProvider call', () => {
  const registry = new SessionImplementationRegistry();
  const { created } = register(registry);
  const ref = { pluginId: 'acme', contributionId: 'intranet-agent' };

  const first = registry.resolve(ref, { catId: 'cat-1' });
  const second = registry.resolve(ref, { catId: 'cat-1' });

  assert.equal(created.length, 1, 'createProvider must run once per catId');
  assert.equal(first, second);
  assert.equal(first.catId, 'cat-1');
  assert.deepEqual(first.declaration, DECLARATION);
});

test('[36] different catIds get different provider objects', () => {
  const registry = new SessionImplementationRegistry();
  const { created } = register(registry);
  const ref = { pluginId: 'acme', contributionId: 'intranet-agent' };

  const one = registry.resolve(ref, { catId: 'cat-1' });
  const two = registry.resolve(ref, { catId: 'cat-2' });

  assert.equal(created.length, 2);
  assert.notEqual(one, two);
  assert.equal(one.catId, 'cat-1');
  assert.equal(two.catId, 'cat-2');
});

test('[36] unregistering removes the ref; a second unregister is a no-op', () => {
  const registry = new SessionImplementationRegistry();
  const { unregister } = register(registry);
  const ref = { pluginId: 'acme', contributionId: 'intranet-agent' };

  assert.equal(typeof unregister, 'function');
  assert.ok(registry.resolve(ref, { catId: 'cat-1' }));

  unregister();

  assert.equal(registry.resolve(ref, { catId: 'cat-1' }), undefined);
  assert.doesNotThrow(() => unregister());
  assert.equal(registry.resolve(ref, { catId: 'cat-1' }), undefined);
});

test('[36] registering the same key twice throws', () => {
  const registry = new SessionImplementationRegistry();
  register(registry);

  assert.throws(() => register(registry));
});

test('[36] re-registering after unregister yields a fresh provider object', () => {
  const registry = new SessionImplementationRegistry();
  const first = register(registry);
  const ref = { pluginId: 'acme', contributionId: 'intranet-agent' };
  const before = registry.resolve(ref, { catId: 'cat-1' });

  first.unregister();
  const second = register(registry);
  const after = registry.resolve(ref, { catId: 'cat-1' });

  assert.equal(second.key, first.key);
  assert.ok(after);
  assert.notEqual(after, before);
});
