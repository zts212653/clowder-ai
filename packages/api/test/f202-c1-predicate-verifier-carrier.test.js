import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';

const provider = {
  type: 'terminal-predicate-provider',
  id: 'review',
  actionFamily: 'review',
  predicateKind: 'review_delivered',
  subjectNamespace: 'pr',
  freshnessMethod: 'review.freshness',
  completionMethod: 'review.completion',
};
function manifest(withProvider = true) {
  return {
    pluginId: 'dev.clowder.verifier-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Verifier fixture',
    runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
    features: [
      {
        id: 'review',
        name: 'Review',
        resources: [],
        capabilities: withProvider ? ['custody.verify'] : [],
        ...(withProvider ? { contributions: [{ type: provider.type, id: provider.id }] } : {}),
      },
    ],
    ...(withProvider ? { contributions: [provider] } : {}),
  };
}
const both = `{ 'review.freshness': async () => ({}), 'review.completion': async () => ({}) }`;
async function fixture(
  t,
  { table = both, actions = '{}', withProvider = true, grants = ['custody.verify'], handler } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-verifier-carrier-'));
  const hookKey = randomUUID();
  if (handler) {
    globalThis[hookKey] = handler;
    table = `{ 'review.freshness': (...args) => globalThis[${JSON.stringify(hookKey)}](...args), 'review.completion': (...args) => globalThis[${JSON.stringify(hookKey)}](...args) }`;
  }
  t.after(() => {
    delete globalThis[hookKey];
  });
  const declared = manifest(withProvider);
  const validation = validateManifest(declared);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  await writeFile(
    join(rootDir, 'plugin.mjs'),
    `export default { create() { return { start() { return {
    actions: ${actions}, ${table === undefined ? '' : `predicateVerifiers: ${table},`} stop() {}
  }; } }; } };`,
  );
  let released = 0;
  const runtime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir,
        manifest: declared,
        verifyIntegrity: async () => {},
        release: async () => {
          released++;
        },
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    log() {},
  });
  t.after(async () => {
    await runtime.stop('instance', 'test_cleanup');
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    runtime,
    released: () => released,
    start: () =>
      runtime.start(
        'instance',
        { pluginId: declared.pluginId, packageDigest: 'fixture-digest', manifest: declared },
        grants,
      ),
  };
}
for (const [name, options] of [
  ['missing declared verifier', { table: `{ 'review.freshness': async () => ({}) }` }],
  ['extra undeclared verifier', { table: `{ ...${both}, surprise: async () => ({}) }` }],
  ['inherited verifier is not an implementation', { table: `Object.create(${both})` }],
  ['verifier cannot also be an ordinary action', { actions: `{ 'review.completion': async () => ({}) }` }],
  ['ungranted verifier table has no authority', { grants: [] }],
  ['table without a provider declaration is rejected', { withProvider: false }],
  ['verifier table must be a record of functions', { table: `[]` }],
]) {
  test(name, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(f.start, { code: 'PROTOCOL_VIOLATION' });
    assert.equal(f.released(), 1, 'invalid activation must release its package');
  });
}
test('declared and granted verifier table activates without exposing ordinary actions', async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.equal(f.runtime.exposesAction('instance', 'review.freshness'), false);
  await assert.rejects(() => f.runtime.invoke('instance', 'review.completion', {}), { code: 'PROTOCOL_VIOLATION' });
});
test('an ungranted feature can remain inactive with an empty verifier table', async (t) => {
  const f = await fixture(t, { grants: [], table: '{}' });
  await f.start();
  assert.equal(f.runtime.exposesAction('instance', 'review.freshness'), false);
});

function request(completion = false) {
  const subjectRef = 'pr:owner/repo#1';
  const predicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'review',
    subjectRef,
    predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
  });
  return {
    actionFamily: 'review',
    subjectRef,
    predicate,
    ...(completion ? { leaseId: 'lease-1', generation: 1, evidenceRefs: ['github:delivery-1'] } : {}),
  };
}
function context(phase = 'freshness') {
  return {
    phase,
    tenantScope: 'owner',
    installationProjectRoot: '/fixture/project',
    binding: {
      pluginInstanceId: 'instance',
      packageDigest: 'fixture-digest',
      featureId: 'review',
      contributionId: 'review',
      freshnessMethod: 'review.freshness',
      completionMethod: 'review.completion',
      grantRevision: 1,
      lifecycleRevision: 1,
      tenantScope: 'owner',
      installationProjectRoot: '/fixture/project',
    },
    assignment: { holderCatIds: ['astra'], holderThreadId: 'thread-1' },
    principal: {
      catId: 'astra',
      threadId: 'thread-1',
      userId: 'owner',
      ...(phase === 'completion' ? { invocationId: 'turn-1' } : {}),
    },
    signal: new AbortController().signal,
    assertCurrent: async () => {},
  };
}
function verified(input) {
  return {
    status: 'verified',
    evidenceRef: 'github:delivery-1',
    freshnessKey: input.predicate.freshnessKey,
    ...('evidenceRefs' in input
      ? { predicateDigest: input.predicate.digest }
      : { ownerCatId: 'astra', holderThreadId: 'thread-1' }),
  };
}

test('private verifier isolates both native ALS identities and whitelists its frozen context', async (t) => {
  const calls = [];
  const f = await fixture(t, {
    handler: async (input, ctx) => {
      assert.equal(currentPluginCallContext('instance'), undefined);
      assert.equal(currentPluginCallContext('other-instance'), undefined);
      await Promise.resolve();
      assert.equal(currentPluginCallContext('other-instance'), undefined);
      assert.equal('invocationId' in ctx.principal, false);
      assert.equal('extraHostFunction' in ctx, false);
      assert.ok(
        Object.isFrozen(input.predicate) &&
          Object.isFrozen(ctx.binding) &&
          Object.isFrozen(ctx.assignment.holderCatIds),
      );
      assert.throws(() => {
        input.predicate.digest = 'forged';
      }, TypeError);
      calls.push(ctx);
      return verified(input);
    },
  });
  await f.start();
  const ctx = context();
  ctx.extraHostFunction = () => {
    throw Error('must not leak');
  };
  ctx.principal.invocationId = 'must-not-leak-in-freshness';
  const native = { ...context('completion').principal, assertCurrent: async () => {} };
  await withPluginCallContext('other-instance', native, async () => {
    const result = await f.runtime.invokePredicateVerifier('instance', 'review.freshness', request(), ctx);
    assert.equal(result.status, 'verified');
    assert.equal(currentPluginCallContext('other-instance'), native, 'outer context restored');
  });
  await assert.rejects(calls[0].assertCurrent, /expired/);
});
test('completion exposes real invocation and accepts only its frozen evidence and digest', async (t) => {
  const f = await fixture(t, {
    handler: async (input, ctx) => {
      assert.equal(ctx.principal.invocationId, 'turn-1');
      return verified(input);
    },
  });
  await f.start();
  assert.equal(
    (await f.runtime.invokePredicateVerifier('instance', 'review.completion', request(true), context('completion')))
      .status,
    'verified',
  );
});
for (const [name, mutate] of [
  [
    'wrong phase',
    (ctx) => {
      ctx.phase = 'completion';
    },
  ],
  [
    'wrong instance',
    (ctx) => {
      ctx.binding.pluginInstanceId = 'other';
    },
  ],
  [
    'wrong contribution',
    (ctx) => {
      ctx.binding.contributionId = 'other';
    },
  ],
  [
    'wrong tenant',
    (ctx) => {
      ctx.principal.userId = 'other';
    },
  ],
]) {
  test(`rejects ${name} before entering verifier`, async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      handler: async (input) => {
        calls++;
        return verified(input);
      },
    });
    await f.start();
    const ctx = context();
    mutate(ctx);
    await assert.rejects(() => f.runtime.invokePredicateVerifier('instance', 'review.freshness', request(), ctx));
    assert.equal(calls, 0);
  });
}
for (const [name, result] of [
  ['extra authority', (input) => ({ ...verified(input), committed: true })],
  ['wrong owner', (input) => ({ ...verified(input), ownerCatId: 'other-cat' })],
  ['wrong freshness', (input) => ({ ...verified(input), freshnessKey: 'stale' })],
]) {
  test(`rejects verifier result with ${name}`, async (t) => {
    const f = await fixture(t, { handler: async (input) => result(input) });
    await f.start();
    await assert.rejects(() => f.runtime.invokePredicateVerifier('instance', 'review.freshness', request(), context()));
  });
}
test('authority is rechecked after awaited package work', async (t) => {
  let revoked = false;
  const f = await fixture(t, {
    handler: async (input) => {
      await Promise.resolve();
      revoked = true;
      return verified(input);
    },
  });
  await f.start();
  const ctx = context();
  ctx.assertCurrent = async () => {
    if (revoked) throw Error('revoked');
  };
  await assert.rejects(
    () => f.runtime.invokePredicateVerifier('instance', 'review.freshness', request(), ctx),
    /revoked/,
  );
});
test('stopping the module while its verifier awaits rejects the late result', async (t) => {
  let f;
  f = await fixture(t, {
    handler: async (input) => {
      await f.runtime.stop('instance', 'disabled');
      return verified(input);
    },
  });
  await f.start();
  await assert.rejects(
    () => f.runtime.invokePredicateVerifier('instance', 'review.freshness', request(), context()),
    /activation changed/,
  );
});
test('abort settles a hung verifier and expires any retained context fence', async (t) => {
  const abort = new AbortController();
  let captured;
  const f = await fixture(t, {
    handler: async (_, ctx) => {
      captured = ctx;
      abort.abort();
      return new Promise(() => {});
    },
  });
  await f.start();
  const ctx = context();
  ctx.signal = abort.signal;
  await assert.rejects(
    () => f.runtime.invokePredicateVerifier('instance', 'review.freshness', request(), ctx),
    /cancelled/,
  );
  await assert.rejects(captured.assertCurrent, /expired/);
});

test('mutating ordinary actions after activation cannot expose a private verifier name', async (t) => {
  const f = await fixture(t, {
    actions: `{ mutate() { this['review.completion'] = async () => ({ forged: true }); } }`,
  });
  await f.start();
  await f.runtime.invoke('instance', 'mutate', {});
  assert.equal(f.runtime.exposesAction('instance', 'review.completion'), false);
  await assert.rejects(() => f.runtime.invoke('instance', 'review.completion', {}), { code: 'PROTOCOL_VIOLATION' });
});
