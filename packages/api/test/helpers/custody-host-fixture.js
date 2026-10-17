import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionSuccessorCompletionService } from '../../dist/domains/ball-custody/ActionSuccessorCompletionService.js';
import { canonicalizeActionTerminalPredicate } from '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  claimActionSuccessor,
  commitActionCompletionVerdict,
  preflightActionSuccessor,
  recordActionCompletionCandidate,
} from '../../dist/domains/ball-custody/action-successor-state-machine.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { currentPluginCallContext } from '../../dist/domains/plugin/carrier/plugin-call-context.js';
import { createDormantPluginRuntimeComposition } from '../../dist/domains/plugin/runtime-composition.js';

export const canonicalInput = {
  actionFamily: 'review',
  subjectRef: 'pr:owner/repo#42',
  predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
};
export const digest = canonicalizeActionTerminalPredicate(canonicalInput).digest;

export async function fixture(t, { unavailable = false, persistentStore } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'f202-custody-host-'));
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot);
  let mcpConfig = null;
  const key = randomUUID();
  let host;
  let storedLease = null;
  let runtime;
  let onVerify = async () => {};
  let verifierCalls = 0;
  let lastCompletionInput;
  const leaseStore = persistentStore ?? {
    get: async () => structuredClone(storedLease),
    preflightOutput: async (_id, generation, catId, terminalPredicateDigest) => {
      assert.equal(catId, 'reviewer');
      return preflightActionSuccessor(storedLease, { generation, terminalPredicateDigest, subjectTerminal: false });
    },
    recordCompletionCandidate: async (_id, input) => {
      lastCompletionInput = input;
      storedLease = recordActionCompletionCandidate(storedLease, input);
      return { outcome: 'recorded', lease: structuredClone(storedLease) };
    },
    commitCompletionVerdict: async (_id, input) => {
      storedLease = commitActionCompletionVerdict(storedLease, input);
      return { outcome: 'committed', lease: structuredClone(storedLease) };
    },
  };
  const completionService = new ActionSuccessorCompletionService(leaseStore, {
    authorizeCompletion: (lease, actor) => runtime.predicateProvider.authorizeCompletion(lease, actor),
    resolveCompletion: async () => {
      throw Error('bound completion must not use the task resolver');
    },
  });
  globalThis[key] = (value) => {
    host = value;
  };
  const verifyKey = randomUUID();
  globalThis[verifyKey] = async (input, context) => {
    assert.equal(currentPluginCallContext(context.binding.pluginInstanceId), undefined);
    await runtime.inventoryStore.snapshot();
    if (context.phase === 'completion') {
      verifierCalls++;
      await assert.rejects(() => host.custody.canonicalize(canonicalInput), /native invocation/);
      await onVerify(input);
      return {
        status: 'verified',
        predicateDigest: input.predicate.digest,
        freshnessKey: input.predicate.freshnessKey,
        evidenceRef: input.evidenceRefs[0],
      };
    }
    return {
      status: 'verified',
      evidenceRef: 'github:https://github.com/owner/repo/pull/42',
      freshnessKey: input.predicate.freshnessKey,
      ownerCatId: 'reviewer',
      holderThreadId: 'target',
    };
  };
  const manifest = {
    pluginId: 'dev.clowder.custody-host',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Custody Host fixture',
    runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
    features: [
      {
        id: 'invoke',
        name: 'Invoke',
        resources: [],
        capabilities: ['custody.invoke'],
        contributions: [{ type: 'mcp', id: 'native' }],
      },
      {
        id: 'verify',
        name: 'Verify',
        resources: [],
        capabilities: ['custody.verify'],
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
      {
        type: 'mcp',
        id: 'native',
        runtime: { transport: 'stdio', entrypoint: 'mcp.js' },
        actions: [{ method: 'custody.exercise' }],
      },
    ],
  };
  const source = `export default { create() { return { start(host) { globalThis[${JSON.stringify(key)}](host); return { actions: { 'custody.exercise': async (input) => { const service=host.custody; return { available: typeof service?.[input.method] === 'function', result: service?.[input.method] ? await service[input.method](input.value) : null }; } }, predicateVerifiers: { 'review.freshness': (...args) => globalThis[${JSON.stringify(verifyKey)}](...args), 'review.completion': (...args) => globalThis[${JSON.stringify(verifyKey)}](...args) }, stop() {} }; } }; } };`;
  await writeFile(join(packageRoot, 'plugin.mjs'), source);
  await writeFile(join(packageRoot, 'mcp.js'), '// Declared native transport fixture; never spawned.\n');
  const packageDigest = 'sha512-' + createHash('sha512').update(source).digest('base64');
  runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    threadOwnerUserId: 'owner',
    messageStore: new MessageStore(),
    ...(unavailable ? {} : { custody: { leaseStore, completionService } }),
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    mcpConfigIO: {
      readConfig: async () => structuredClone(mcpConfig),
      writeAndRegenCli: async (value) => {
        mcpConfig = structuredClone(value);
      },
      withLock: async (operation) => operation(),
    },
  });
  t.after(async () => {
    await runtime.shutdown('test_cleanup');
    delete globalThis[key];
    delete globalThis[verifyKey];
    await rm(root, { recursive: true, force: true });
  });
  const installed = await runtime.inventory.installPackage({
    manifest,
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: manifest.pluginId,
    effectiveGrants: ['custody.invoke', 'custody.verify'],
  });
  await runtime.inventoryStore.transaction((tx) => {
    const instance = tx.instances.get(installed.pluginInstanceId);
    tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled' });
  });
  try {
    await runtime.supervisor.start(installed.pluginInstanceId);
  } catch (error) {
    console.dir(error, { depth: 8 });
    throw error;
  }
  const actions = runtime.supervisor.nativeActions;
  const token = actions.environment(installed.pluginInstanceId, 'native').CLOWDER_PLUGIN_ACTION_TOKEN;
  assert.ok(token, 'actual activation must provide its native action token');
  const caller = {
    catId: 'reviewer',
    threadId: 'target',
    userId: 'owner',
    invocationId: 'native-call',
    assertCurrent: async () => {},
  };
  return {
    runtime,
    leaseStore,
    host: () => host,
    call: (method, value, overrides = {}) =>
      actions.call(token, 'custody.exercise', { method, value }, { ...caller, ...overrides }),
    verifierCalls: () => verifierCalls,
    lastCompletionInput: () => lastCompletionInput,
    storedLease: () => structuredClone(storedLease),
    setLease: (value) => {
      storedLease = value;
    },
    onVerify: (fn) => {
      onVerify = fn;
    },
    revoke: () =>
      runtime.inventoryStore.transaction((tx) => {
        const grant = tx.grants.get(installed.pluginInstanceId);
        tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: [] });
      }),
    claim: async () => {
      const predicate = canonicalizeActionTerminalPredicate(canonicalInput);
      const fresh = await runtime.predicateProvider.resolveFreshness(predicate, {
        tenantScope: 'owner',
        actorCatId: 'author',
        sourceThreadId: 'source',
        targetThreadId: 'target',
        holderCatIds: ['reviewer'],
      });
      assert.equal(fresh.status, 'verified');
      const input = {
        leaseId: 'lease-1',
        tenantScope: 'owner',
        subjectRef: canonicalInput.subjectRef,
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        holderCatIds: ['reviewer'],
        holderThreadId: 'target',
        predecessorCatId: 'author',
        predecessorThreadId: 'source',
        dispatchId: 'dispatch',
        now: 100,
        evidenceRefs: ['message:request'],
        claimOrigin: 'structured_transfer',
        issuerStandingEvidenceRef: 'message:request',
        terminalPredicate: predicate,
        terminalPredicateProviderBinding: fresh.providerAuthority.binding,
      };
      const result = await fresh.providerAuthority.withAuthority(() =>
        persistentStore ? persistentStore.claim(input) : Promise.resolve(claimActionSuccessor(null, input)),
      );
      assert.equal(result.outcome, 'claimed');
      storedLease = result.lease;
      assert.ok(storedLease);
      return { leaseId: storedLease.leaseId, generation: storedLease.generation };
    },
  };
}
