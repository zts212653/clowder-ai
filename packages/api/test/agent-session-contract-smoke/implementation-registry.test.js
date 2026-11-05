// The Host-held implementation registry uses unique keys.
//
// Keys are the only identity; duplicate registration is an error rather than a
// silent overwrite, and unregistering removes exactly one entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SessionImplementationRegistry,
  sessionImplementationKey,
} from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';

test('[extra] implementation keys are builtin:<id> and plugin:<pluginId>/<contributionId>', () => {
  assert.equal(sessionImplementationKey({ builtin: 'acp' }), 'builtin:acp');
  assert.equal(
    sessionImplementationKey({ pluginId: 'plugin-1', contributionId: 'contribution-1' }),
    'plugin:plugin-1/contribution-1',
  );
});

test('[extra] register, resolve, has and unregister act on one ref', () => {
  const registry = new SessionImplementationRegistry();
  const builtin = { builtin: 'acp' };
  const factories = [];

  const unregister = registry.register(builtin, (ctx) => {
    factories.push(ctx);
    return { kind: 'provider-for', catId: ctx.catId };
  });

  assert.equal(typeof unregister, 'function');
  assert.equal(registry.has(builtin), true);
  assert.deepEqual(registry.resolve(builtin, { catId: 'cat-1' }), {
    kind: 'provider-for',
    catId: 'cat-1',
  });
  assert.deepEqual(factories, [{ catId: 'cat-1' }]);

  unregister();

  assert.equal(registry.has(builtin), false);
  assert.equal(registry.resolve(builtin, { catId: 'cat-1' }), undefined);
});

test('[extra] an unknown ref resolves to undefined', () => {
  const registry = new SessionImplementationRegistry();

  assert.equal(registry.has({ builtin: 'acp' }), false);
  assert.equal(registry.resolve({ builtin: 'acp' }, { catId: 'cat-1' }), undefined);
  assert.equal(registry.resolve({ pluginId: 'p', contributionId: 'c' }, { catId: 'cat-1' }), undefined);
});

test('[extra] duplicate registration of the same ref throws', () => {
  const registry = new SessionImplementationRegistry();
  const ref = { builtin: 'acp' };

  registry.register(ref, () => ({ first: true }));

  assert.throws(() => registry.register(ref, () => ({ second: true })));
});

test('[extra] plugin and builtin refs with colliding ids stay distinct', () => {
  const registry = new SessionImplementationRegistry();

  registry.register({ builtin: 'acp' }, () => ({ source: 'builtin' }));
  registry.register({ pluginId: 'acp', contributionId: 'acp' }, () => ({ source: 'plugin' }));

  assert.deepEqual(registry.resolve({ builtin: 'acp' }, { catId: 'cat-1' }), { source: 'builtin' });
  assert.deepEqual(registry.resolve({ pluginId: 'acp', contributionId: 'acp' }, { catId: 'cat-1' }), {
    source: 'plugin',
  });
});
