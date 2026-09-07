import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  createEvalRepairOwnerRuntime,
  EvalRepairOwnerRuntimeRegistration,
} from '../../dist/infrastructure/harness-eval/eval-repair-owner-runtime.js';
import {
  actionRef,
  caseAction,
  dispatchRef,
  MemoryEventLog,
  ownerAuthorizationRef,
  ownerRef,
  principal,
  ref,
  targetVersionRef,
} from './eval-repair-approval-fixtures.js';

const programRef = ref('F311', 'program:composition');
const cycleRef = ref('F311', 'cycle:composition:1');
const interventionRef = ref('F311', 'intervention:composition:1');

function compositionFixture() {
  const eventLog = new MemoryEventLog();
  const cards = [];
  const calls = { epoch: 0, owner: 0, dispatch: 0, authority: 0, lineage: 0, decision: 0 };
  const ownerBindings = {
    async resolveOwnerChangeContract() {
      calls.owner += 1;
      return { status: 'resolved', ownerRef, ownerAuthorizationRef, targetVersionRef, dispatchRef };
    },
    canonicalRepairDispatcher: {
      async materialize() {
        calls.dispatch += 1;
        throw new Error('not exercised by composition test');
      },
    },
    interventionReceiptOwner: {
      async resolve() {
        return null;
      },
    },
    freshOutcomeOwner: {
      async resolve() {
        return null;
      },
    },
    requestAuthorityVerifier: {
      async verify(candidate) {
        calls.authority += 1;
        return candidate.originMessageId === principal.originMessageId
          ? { status: 'verified', principal }
          : { status: 'blocked', reason: 'request_origin_unverified' };
      },
    },
    lineageResolver: {
      async resolve() {
        calls.lineage += 1;
        return { status: 'resolved', caseActionRef: actionRef };
      },
    },
    valueDecisionAuthorityVerifier: {
      async verify() {
        return { status: 'verified', authorityRef: ref('F313', 'owner-session:composition') };
      },
    },
    decisionOwner: {
      async execute() {
        calls.decision += 1;
        return { status: 'blocked', reason: 'not exercised by composition test' };
      },
    },
  };
  const bindingProvider = {
    async resolve() {
      return ownerBindings;
    },
  };
  const registration = new EvalRepairOwnerRuntimeRegistration();
  let connectedOwner;
  let connectedOutcomeService;
  registration.registerBindingProvider(bindingProvider);
  registration.registerEvolutionOwnerConsumer({
    connect(owner) {
      connectedOwner = owner;
    },
  });
  registration.registerOutcomeServiceConsumer({
    connect(service) {
      connectedOutcomeService = service;
    },
  });
  const options = {
    lifecycleVersion: 1,
    loaderVersion: 1,
    routeVersion: 1,
    materializerVersion: 1,
    eventLog,
    approvalIngress: {
      async publish(draft, store) {
        cards.push(structuredClone(draft));
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: 'F266',
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
          createdAt: draft.createdAt,
        };
        await store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    },
    approvalAdapter: {
      featureId: 'F266',
      async listPending() {
        return [];
      },
      async listSettled() {
        return [];
      },
    },
    epochAuthority: {
      async authorize() {
        calls.epoch += 1;
        return {
          allowed: true,
          record: {
            producerId: 'F266',
            epoch: 1,
            revision: 1,
            phase: 'v1_active',
            updatedAt: '2026-09-02T00:00:00.000Z',
            cutoverReceiptRef: 'receipt:f266:v1',
          },
        };
      },
    },
    caseActionResolver: async (candidate) => (candidate === actionRef ? caseAction() : null),
    releaseTruth: {
      loadedRuntimeHead: 'a'.repeat(40),
      verifyMainLanded(commitSha) {
        return { commitSha, evidenceRef: `main:${commitSha}` };
      },
      verifyLiveActive(commitSha) {
        return { commitSha, evidenceRef: `live:${commitSha}` };
      },
    },
    registration,
  };
  return {
    eventLog,
    cards,
    calls,
    ownerBindings,
    bindingProvider,
    registration,
    connectedOwner: () => connectedOwner,
    connectedOutcomeService: () => connectedOutcomeService,
    options,
  };
}

describe('F313 Phase D production owner composition', () => {
  it('is the production bootstrap boundary rather than a test-only factory', async () => {
    const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /createEvalRepairOwnerRuntime\(\{/);
    assert.match(source, /registration: evalRepairOwnerRuntimeRegistration/);
    assert.match(source, /registerF311E0EvalRepairOwnerRuntime\(\{/);
    assert.match(source, /connectEvolutionOwner\(owner\)/);
    assert.match(source, /connectOutcomeService\(service\)/);
    assert.match(source, /evalRepairOutcomeRoutes/);
    assert.match(source, /f266OwnerRuntime\.cutover/);
    assert.doesNotMatch(source, /createEvalRepairCutover\(\{/);
  });

  it('keeps the whole cutover/outcome/F311 adapter dormant when any binding is missing', async () => {
    const baseKeys = [
      'eventLog',
      'approvalIngress',
      'approvalAdapter',
      'epochAuthority',
      'caseActionResolver',
      'releaseTruth',
      'registration',
    ];
    for (const key of baseKeys) {
      const ctx = compositionFixture();
      const result = await createEvalRepairOwnerRuntime({ ...ctx.options, [key]: undefined });
      assert.equal(result.status, 'dormant');
      assert.ok(result.missing.includes(key));
      assert.ok(Object.values(result.effects).every((effect) => effect === false));
      assert.deepEqual(ctx.calls, { epoch: 0, owner: 0, dispatch: 0, authority: 0, lineage: 0, decision: 0 });
    }

    for (const key of Object.keys(compositionFixture().ownerBindings)) {
      const ctx = compositionFixture();
      const bindings = { ...ctx.ownerBindings, [key]: undefined };
      const registration = new EvalRepairOwnerRuntimeRegistration();
      registration.registerBindingProvider({
        async resolve() {
          return bindings;
        },
      });
      registration.registerEvolutionOwnerConsumer({ connect() {} });
      registration.registerOutcomeServiceConsumer({ connect() {} });
      const result = await createEvalRepairOwnerRuntime({
        ...ctx.options,
        registration,
      });
      assert.equal(result.status, 'dormant');
      assert.ok(result.missing.includes(key));
      assert.ok(Object.values(result.effects).every((effect) => effect === false));
      assert.deepEqual(ctx.calls, { epoch: 0, owner: 0, dispatch: 0, authority: 0, lineage: 0, decision: 0 });
    }
  });

  it('keeps the owner journey dormant when the provider is empty, unreadable, or the migration epoch is inactive', async () => {
    const unavailableProviders = [
      {
        async resolve() {
          return undefined;
        },
      },
      {
        async resolve() {
          throw new Error('owner system unavailable');
        },
      },
    ];
    for (const bindingProvider of unavailableProviders) {
      const ctx = compositionFixture();
      const registration = new EvalRepairOwnerRuntimeRegistration();
      registration.registerBindingProvider(bindingProvider);
      registration.registerEvolutionOwnerConsumer({ connect() {} });
      registration.registerOutcomeServiceConsumer({ connect() {} });
      const result = await createEvalRepairOwnerRuntime({ ...ctx.options, registration });
      assert.equal(result.status, 'dormant');
      assert.ok(Object.values(result.effects).every((effect) => effect === false));
      assert.equal(ctx.cards.length, 0);
      assert.deepEqual(ctx.calls, { epoch: 0, owner: 0, dispatch: 0, authority: 0, lineage: 0, decision: 0 });
    }

    const inactive = compositionFixture();
    inactive.options.epochAuthority = {
      async authorize() {
        inactive.calls.epoch += 1;
        return {
          allowed: false,
          record: {
            producerId: 'F266',
            epoch: 0,
            revision: 1,
            phase: 'legacy_active',
            updatedAt: '2026-09-02T00:00:00.000Z',
          },
        };
      },
    };
    const result = await createEvalRepairOwnerRuntime(inactive.options);
    assert.equal(result.status, 'dormant');
    assert.ok(result.missing.includes('epoch:proposal_ingress:v1_active'));
    assert.ok(Object.values(result.effects).every((effect) => effect === false));
    assert.equal(inactive.cards.length, 0);
    assert.deepEqual(inactive.calls, { epoch: 1, owner: 0, dispatch: 0, authority: 0, lineage: 0, decision: 0 });
  });

  it('requires one owner provider plus the outcome and F311 consumer seams without silent replacement', async () => {
    for (const missing of ['provider', 'evolutionConsumer', 'outcomeConsumer']) {
      const ctx = compositionFixture();
      const registration = new EvalRepairOwnerRuntimeRegistration();
      if (missing !== 'provider') registration.registerBindingProvider(ctx.bindingProvider);
      if (missing !== 'evolutionConsumer') registration.registerEvolutionOwnerConsumer({ connect() {} });
      if (missing !== 'outcomeConsumer') registration.registerOutcomeServiceConsumer({ connect() {} });
      const result = await createEvalRepairOwnerRuntime({ ...ctx.options, registration });
      assert.equal(result.status, 'dormant');
      const expected =
        missing === 'provider'
          ? 'ownerBindingProvider'
          : missing === 'evolutionConsumer'
            ? 'evolutionOwnerConsumer'
            : 'outcomeServiceConsumer';
      assert.ok(result.missing.includes(expected));
      assert.equal(ctx.cards.length, 0);
      assert.deepEqual(ctx.calls, { epoch: 0, owner: 0, dispatch: 0, authority: 0, lineage: 0, decision: 0 });
    }

    const registration = new EvalRepairOwnerRuntimeRegistration();
    const provider = compositionFixture().bindingProvider;
    registration.registerBindingProvider(provider);
    assert.throws(() => registration.registerBindingProvider(provider), /already registered/);
    const consumer = { connect() {} };
    registration.registerEvolutionOwnerConsumer(consumer);
    assert.throws(() => registration.registerEvolutionOwnerConsumer(consumer), /already registered/);
    registration.registerOutcomeServiceConsumer(consumer);
    assert.throws(() => registration.registerOutcomeServiceConsumer(consumer), /already registered/);
  });

  it('resolves one concrete binding snapshot into the cutover, outcome service, and reachable F311 port', async () => {
    const ctx = compositionFixture();
    const result = await createEvalRepairOwnerRuntime(ctx.options);
    assert.equal(result.status, 'active');
    assert.equal(result.cutover.service, result.approvalService);
    assert.ok(result.outcomeService);
    assert.ok(result.evolutionOwner);
    assert.equal(ctx.connectedOwner(), result.evolutionOwner);
    assert.equal(ctx.connectedOutcomeService(), result.outcomeService);

    const requested = await result.evolutionOwner.requestApproval({
      programRef,
      cycleRef,
      interventionRef,
      clientMessageId: 'composition-request-1',
      requestAuthority: principal,
    });
    assert.equal(requested.status, 'pending');
    assert.equal(ctx.cards.length, 1);
    assert.deepEqual(ctx.calls, { epoch: 4, owner: 1, dispatch: 0, authority: 1, lineage: 1, decision: 0 });
  });
});
