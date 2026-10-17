import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { createActionCompletionCandidateSnapshot } from '../dist/domains/ball-custody/action-successor-completion-state-machine.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { PluginPredicateProviderRegistry } from '../dist/domains/plugin/custody/predicate-provider-registry.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/runtime-composition.js';

const predicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: 'pr:owner/repo#42',
  predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
});
const admission = {
  tenantScope: 'owner',
  actorCatId: 'author',
  sourceThreadId: 'source',
  targetThreadId: 'target',
  holderCatIds: ['reviewer'],
};
const evidenceRef = 'github:https://github.com/owner/repo/pull/42#pullrequestreview-123';
const candidate = createActionCompletionCandidateSnapshot({
  evidenceRefs: [evidenceRef],
  candidateRevision: 3,
  recordedAt: 10,
});
const native = () => ({
  catId: 'reviewer',
  threadId: 'target',
  userId: 'owner',
  invocationId: 'invocation',
  assertCurrent: async () => {},
  assertInvocationCurrent: async () => {},
});
const lease = (binding) => ({
  leaseId: 'lease',
  generation: 2,
  actionFamily: 'review',
  tenantScope: 'owner',
  holderThreadId: 'target',
  holderCatIds: ['reviewer'],
  terminalPredicate: predicate,
  terminalPredicateProviderBinding: binding,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'f202-registry-authority-'));
  const entries = new Map();
  const keys = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    threadOwnerUserId: 'owner',
    messageStore: new MessageStore(),
    packages: {
      resolveInstalledPackage: async (digest) => {
        const entry = entries.get(digest);
        assert.ok(entry, 'test must locate an installed package');
        return { ...entry, verifyIntegrity: async () => {}, release: async () => {} };
      },
    },
    mcpConfigIO: { read: async () => ({}), write: async () => {} },
  });
  t.after(async () => {
    await runtime.shutdown('test_cleanup');
    for (const key of keys) delete globalThis[key];
    await rm(root, { recursive: true, force: true });
  });
  const calls = [];
  let hook = async (input, context) =>
    context.phase === 'freshness'
      ? {
          status: 'verified',
          evidenceRef,
          freshnessKey: input.predicate.freshnessKey,
          ownerCatId: 'reviewer',
          holderThreadId: 'target',
        }
      : {
          status: 'verified',
          evidenceRef,
          freshnessKey: input.predicate.freshnessKey,
          predicateDigest: input.predicate.digest,
        };
  async function install(suffix, { enabled = true, grants = ['custody.verify', 'custody.invoke'] } = {}) {
    const pluginId = `dev.clowder.registry-${suffix}`;
    const key = randomUUID();
    keys.push(key);
    globalThis[key] = async (input, context) => {
      assert.equal(
        currentPluginCallContext(context.binding.pluginInstanceId),
        undefined,
        'verifier must not inherit business ALS',
      );
      // Real inventory can be read here: package/provider IO must not hold its write lock.
      await runtime.inventoryStore.snapshot();
      calls.push({ input, context });
      return hook(input, context);
    };
    const manifest = {
      pluginId,
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'Registry provider fixture',
      runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
      features: [
        {
          id: 'review',
          name: 'Review',
          resources: [],
          capabilities: ['custody.verify', 'custody.invoke'],
          contributions: [{ type: 'terminal-predicate-provider', id: 'review' }],
        },
      ],
      contributions: [
        {
          type: 'terminal-predicate-provider',
          id: 'review',
          actionFamily: 'review',
          predicateKind: 'review_delivered',
          subjectNamespace: 'pr',
          freshnessMethod: 'review.freshness',
          completionMethod: 'review.completion',
        },
      ],
    };
    const rootDir = join(root, suffix);
    await mkdir(rootDir);
    const bytes = `export default { create() { return { start() { return { actions: {}, predicateVerifiers: { 'review.freshness': (...args) => globalThis[${JSON.stringify(key)}](...args), 'review.completion': (...args) => globalThis[${JSON.stringify(key)}](...args) }, stop() {} }; } }; } };`;
    await writeFile(join(rootDir, 'plugin.mjs'), bytes);
    const digest =
      'sha512-' +
      createHash('sha512')
        .update(bytes + JSON.stringify(manifest))
        .digest('base64');
    entries.set(digest, { rootDir, manifest });
    const installed = await runtime.inventory.installPackage({
      manifest,
      computedPackageDigest: digest,
      expectedPackageDigest: digest,
      packagePluginId: pluginId,
      effectiveGrants: grants,
    });
    await runtime.inventoryStore.transaction((tx) => {
      const instance = tx.instances.get(installed.pluginInstanceId);
      tx.instances.put({ ...instance, configReadiness: 'ready', activationState: enabled ? 'enabled' : 'disabled' });
    });
    if (enabled) await runtime.supervisor.start(installed.pluginInstanceId);
    return installed.pluginInstanceId;
  }
  async function revoke(id) {
    await runtime.inventoryStore.transaction((tx) => {
      const grant = tx.grants.get(id);
      tx.grants.put({ ...grant, effectiveGrants: [], grantRevision: grant.grantRevision + 1 });
    });
  }
  return {
    runtime,
    install,
    revoke,
    calls,
    setHook: (fn) => {
      hook = fn;
    },
    fresh: () => runtime.predicateProvider.resolveFreshness(predicate, admission),
  };
}

test('real composition uses installed declarations, separate actor/holder identity and a guarded binding', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  const result = await f.fresh();
  assert.equal(result.status, 'verified');
  assert.equal(result.tenantScope, 'owner');
  assert.equal(result.approvedDelegates, undefined);
  assert.equal(result.providerAuthority.binding.pluginInstanceId, id);
  assert.deepEqual(f.calls[0].context.principal, { catId: 'author', threadId: 'source', userId: 'owner' });
  assert.deepEqual(f.calls[0].context.assignment, { holderCatIds: ['reviewer'], holderThreadId: 'target' });
  let writes = 0;
  await result.providerAuthority.withAuthority(async () => {
    writes++;
  });
  await f.revoke(id);
  await assert.rejects(() =>
    result.providerAuthority.withAuthority(async () => {
      writes++;
    }),
  );
  assert.equal(writes, 1);
});

test('foreign tenant is refused before consulting any provider', async (t) => {
  const f = await fixture(t);
  await f.install('one');
  assert.equal(
    (await f.runtime.predicateProvider.resolveFreshness(predicate, { ...admission, tenantScope: 'foreign' })).status,
    'insufficient',
  );
  assert.equal(f.calls.length, 0);
});

test('authorized disabled competitor makes new selection ambiguous without fallback', async (t) => {
  const f = await fixture(t);
  await f.install('one');
  await f.install('two', { enabled: false });
  const result = await f.fresh();
  assert.equal(result.status, 'insufficient');
  assert.match(result.reason, /ambiguous/);
  assert.equal(f.calls.length, 0);
});

test('a partially authorized feature is not a provider', async (t) => {
  const f = await fixture(t);
  await f.install('one', { enabled: false, grants: ['custody.verify'] });
  assert.equal((await f.fresh()).status, 'insufficient');
  assert.equal(f.calls.length, 0);
});

test('revoke during freshness IO prevents returning write authority', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  f.setHook(async (input) => {
    await f.revoke(id);
    return {
      status: 'verified',
      evidenceRef,
      freshnessKey: input.predicate.freshnessKey,
      ownerCatId: 'reviewer',
      holderThreadId: 'target',
    };
  });
  await assert.rejects(f.fresh);
});

test('bound completion needs its exact live native instance, user, cat and thread', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  const bound = lease((await f.fresh()).providerAuthority.binding);
  const registry = f.runtime.predicateProvider;
  assert.equal((await registry.authorizeCompletion(bound, { catId: 'reviewer' })).status, 'insufficient');
  for (const [instance, patch] of [
    [id, { userId: 'foreign' }],
    [id, { threadId: 'other' }],
    [id, { catId: 'other' }],
    ['other-instance', {}],
    [id, { assertInvocationCurrent: undefined }],
  ]) {
    const result = await withPluginCallContext(instance, { ...native(), ...patch }, () =>
      registry.authorizeCompletion(bound, { catId: 'reviewer' }),
    );
    assert.equal(result.status, 'insufficient');
  }
  assert.equal(f.calls.length, 1);
});

test('Host binds a validated completion result to the candidate, with IO outside inventory lock', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  const bound = lease((await f.fresh()).providerAuthority.binding);
  await withPluginCallContext(id, native(), async () => {
    const authority = await f.runtime.predicateProvider.authorizeCompletion(bound, { catId: 'reviewer' });
    assert.equal(authority.status, 'authorized');
    const result = await authority.resolveCompletion(predicate, candidate);
    assert.equal(result.status, 'verified');
    assert.equal(result.candidateRevision, 3);
    assert.equal(result.evidenceDigest, candidate.evidenceDigest);
    assert.equal(f.calls[1].input.candidateRevision, undefined);
    assert.equal(f.calls[1].input.evidenceDigest, undefined);
    assert.equal(f.calls[1].context.principal.invocationId, 'invocation');
    await authority.withAuthority(async () => {});
  });
});

test('bound completion ignores newly installed competitors and never rebinds a retired instance', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  const bound = lease((await f.fresh()).providerAuthority.binding);
  await f.install('two', { enabled: false });
  await withPluginCallContext(id, native(), async () => {
    const authority = await f.runtime.predicateProvider.authorizeCompletion(bound, { catId: 'reviewer' });
    assert.equal(authority.status, 'authorized');
    await f.runtime.inventoryStore.transaction((tx) => {
      const item = tx.instances.get(id);
      tx.instances.put({ ...item, lifecycleRevision: item.lifecycleRevision + 1 });
    });
    await assert.rejects(() => authority.withAuthority(async () => assert.fail('stale binding write')));
  });
});

test('same durable binding resumes after runtime stop/start but not a lifecycle revision change', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  const bound = lease((await f.fresh()).providerAuthority.binding);
  await f.runtime.supervisor.stop(id, 'test_restart');
  await withPluginCallContext(id, native(), () =>
    assert.rejects(() => f.runtime.predicateProvider.authorizeCompletion(bound, { catId: 'reviewer' })),
  );
  await f.runtime.supervisor.start(id);
  const reloaded = new PluginPredicateProviderRegistry(f.runtime.inventoryStore, f.runtime.supervisor, {
    tenantScope: 'owner',
    installationProjectRoot: f.runtime.projectRoot,
  });
  await withPluginCallContext(id, native(), async () =>
    assert.equal((await reloaded.authorizeCompletion(bound, { catId: 'reviewer' })).status, 'authorized'),
  );
});

test('revoke during completion IO prevents verdict and subsequent CAS guard', async (t) => {
  const f = await fixture(t);
  const id = await f.install('one');
  const bound = lease((await f.fresh()).providerAuthority.binding);
  await withPluginCallContext(id, native(), async () => {
    const authority = await f.runtime.predicateProvider.authorizeCompletion(bound, { catId: 'reviewer' });
    f.setHook(async (input) => {
      await f.revoke(id);
      return {
        status: 'verified',
        evidenceRef,
        predicateDigest: input.predicate.digest,
        freshnessKey: input.predicate.freshnessKey,
      };
    });
    await assert.rejects(() => authority.resolveCompletion(predicate, candidate));
    await assert.rejects(() => authority.withAuthority(async () => assert.fail('revoked CAS')));
  });
});

test('provider timeout cancels verifier work without manufacturing authority', async (t) => {
  const f = await fixture(t);
  await f.install('one');
  f.setHook(() => new Promise(() => {}));
  const registry = new PluginPredicateProviderRegistry(
    f.runtime.inventoryStore,
    f.runtime.supervisor,
    { tenantScope: 'owner', installationProjectRoot: f.runtime.projectRoot },
    25,
  );
  // Keep the test loop live while the unref AbortSignal timer exercises cancellation.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(() => registry.resolveFreshness(predicate, admission));
  } finally {
    clearTimeout(keepAlive);
  }
});

test('background recovery uses the persisted provider despite a newly installed competitor, without native identity', async (t) => {
  const f = await fixture(t);
  const first = await f.install('recovery-original');
  const fresh = await f.fresh();
  const frozen = {
    ...lease(fresh.providerAuthority.binding),
    predecessorCatId: 'author',
    predecessorThreadId: 'source',
  };
  await f.install('recovery-competitor');
  assert.equal((await f.fresh()).status, 'insufficient', 'new admission remains ambiguous');
  const recovery = await f.runtime.predicateProvider.authorizeDispatchRecovery(frozen, admission);
  assert.equal(recovery.status, 'authorized');
  const resumed = await recovery.resolveFreshness();
  assert.equal(resumed.status, 'verified');
  const last = f.calls.at(-1);
  assert.equal(last.context.binding.pluginInstanceId, first);
  assert.deepEqual(last.context.principal, { catId: 'author', threadId: 'source', userId: 'owner' });
  assert.equal(last.context.principal.invocationId, undefined);
  let writes = 0;
  await recovery.withAuthority(async () => {
    writes++;
  });
  await f.revoke(first);
  await assert.rejects(() =>
    recovery.withAuthority(async () => {
      writes++;
    }),
  );
  await assert.rejects(() => recovery.resolveFreshness());
  assert.equal(writes, 1);
});

test('bound recovery refuses substituted actor, assignment, tenant or persisted binding', async (t) => {
  const f = await fixture(t);
  await f.install('recovery-source');
  const fresh = await f.fresh();
  const frozen = {
    ...lease(fresh.providerAuthority.binding),
    predecessorCatId: 'author',
    predecessorThreadId: 'source',
  };
  const count = f.calls.length;
  for (const patch of [
    { actorCatId: 'reviewer' },
    { sourceThreadId: 'other' },
    { tenantScope: 'other' },
    { targetThreadId: 'other' },
    { holderCatIds: ['other'] },
  ])
    assert.equal(
      (await f.runtime.predicateProvider.authorizeDispatchRecovery(frozen, { ...admission, ...patch })).status,
      'insufficient',
    );
  assert.equal(
    (
      await f.runtime.predicateProvider.authorizeDispatchRecovery(
        { ...frozen, terminalPredicateProviderBinding: undefined },
        admission,
      )
    ).status,
    'insufficient',
  );
  await assert.rejects(() =>
    f.runtime.predicateProvider.authorizeDispatchRecovery(
      {
        ...frozen,
        terminalPredicateProviderBinding: { ...fresh.providerAuthority.binding, grantRevision: 999 },
      },
      admission,
    ),
  );
  assert.equal(f.calls.length, count);
});
