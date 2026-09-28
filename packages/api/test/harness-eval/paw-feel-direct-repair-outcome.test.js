import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PawFeelDirectRepairBindingVerifier } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-binding-verifier.js';
import {
  derivePawFeelProviderRouteRef,
  PawFeelDirectRepairFederation,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairOutcomeResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-outcome-resolver.js';

const ref = (ownerFeatureId, ownerStateRef, version) => ({
  ownerFeatureId,
  ownerStateRef,
  ...(version ? { version } : {}),
});
const source = {
  sourceSignalRef: ref('F278', 'paw-feel-signal:signal-1', `${'a'.repeat(64)}:0`),
  sourceToolRef: ref('F167', 'mcp-tool:cat_cafe_hold_ball'),
  markerDigest: 'a'.repeat(64),
  sameDigestOrdinal: 0,
  markerIndex: 0,
};
const route = (providerVersion = 'v1') => ({
  schemaVersion: 1,
  providerId: 'f167-owner',
  providerVersion,
  sourceToolRoutes: [{ ownerFeatureId: 'F167', ownerStateRef: 'mcp-tool:cat_cafe_hold_ball', match: 'exact' }],
});
const binding = {
  schemaVersion: 1,
  bindingRef: ref('F278', `paw-feel-direct-repair-binding:sha256:${'b'.repeat(64)}`),
  sourceSignalRef: source.sourceSignalRef,
  sourceToolRef: source.sourceToolRef,
  providerId: 'f167-owner',
  providerVersion: 'v1',
  providerRouteRef: derivePawFeelProviderRouteRef(route()),
  resolvedActionRef: ref('F167', 'action:repair-1'),
  actionScopeRef: ref('F167', 'action-scope:hold-ball'),
  ownerAuthorizationRef: ref('F167', 'authorization:existing'),
  targetVersionRef: {
    ...ref('F167', 'action-target:hold-ball', 'v1'),
    assetKind: 'mcp_tool',
    assetId: 'cat_cafe_hold_ball',
  },
  ownerCatId: 'opus',
  outcomeVerifierRef: ref('F167', 'outcome-verifier:hold-ball:v1'),
};
const projection = {
  signalId: 'signal-1',
  sourceMessageId: 'message-1',
  sourceThreadId: 'thread-source',
  sourceCatId: 'codex-sol',
  markerDigest: 'a'.repeat(64),
  sameDigestOrdinal: 0,
  markerIndex: 0,
  state: 'fix',
  sequence: 2,
  discoveredAt: '2026-09-01T00:00:00.000Z',
  lastTransitionAt: '2026-09-01T00:00:01.000Z',
  ownerCatId: 'opus',
  taskId: 'task-1',
  actionLeaseRef: { leaseId: 'lease-1', generation: 2 },
  custodyEvidenceRef: 'action-lease:lease-1:generation:2',
  directRepairBinding: binding,
  backfilled: false,
  captureMethod: 'typed',
  captureAssessment: 'confirmed',
};
const terminal = {
  ownerCatId: 'opus',
  taskTerminalRef: ref('F310', 'task-terminal:task-1', '7'),
  leaseTerminalRef: ref('F167', 'action-successor-terminal:lease-1', '2:9'),
};
const ownerOutcomeRef = ref('F167', 'owner-outcome:repair-1', '1');

function harness({ providerRoute = route(), terminalResolver, outcomeCalls = [] } = {}) {
  const provider = {
    async resolveAuthority() {
      throw new Error('not used');
    },
    async verifyOutcome(input) {
      outcomeCalls.push(input);
      return {
        schemaVersion: 1,
        bindingRef: input.binding.bindingRef,
        taskTerminalRef: input.taskTerminalRef,
        leaseTerminalRef: input.leaseTerminalRef,
        ownerOutcomeRef: input.ownerOutcomeRef,
        verificationRefs: [ref('F167', 'verification:loaded-main', 'abc')],
        disposition: 'verified_changed',
      };
    },
  };
  const sourceVerifier = {
    async verify() {
      return source;
    },
  };
  const federation = new PawFeelDirectRepairFederation([{ route: providerRoute, provider }]);
  return new PawFeelDirectRepairOutcomeResolver({
    bindingVerifier: new PawFeelDirectRepairBindingVerifier({ sourceVerifier, federation }),
    terminalResolver: terminalResolver ?? {
      async resolve() {
        return terminal;
      },
    },
  });
}

describe('F313 direct repair outcome verifier', () => {
  it('requires the bound owner actor and exact terminal Task/F167 truth', async () => {
    const resolver = harness();
    await assert.rejects(
      resolver.resolve({
        projection,
        actor: { kind: 'cat', id: 'sonnet' },
        bindingRef: binding.bindingRef,
        ownerOutcomeRef,
      }),
      (error) => error?.code === 'owner_mismatch',
    );
    const terminalMissing = harness({
      terminalResolver: {
        async resolve() {
          throw new Error('task is not done');
        },
      },
    });
    await assert.rejects(
      terminalMissing.resolve({
        projection,
        actor: { kind: 'cat', id: 'opus' },
        bindingRef: binding.bindingRef,
        ownerOutcomeRef,
      }),
      (error) => error?.code === 'terminal_evidence_invalid',
    );
  });

  it('rejects provider route/version drift before consulting the owner outcome verifier', async () => {
    const calls = [];
    const resolver = harness({ providerRoute: route('v2'), outcomeCalls: calls });
    await assert.rejects(
      resolver.resolve({
        projection,
        actor: { kind: 'cat', id: 'opus' },
        bindingRef: binding.bindingRef,
        ownerOutcomeRef,
      }),
      (error) => error?.code === 'binding_mismatch',
    );
    assert.deepEqual(calls, []);
  });

  it('turns source/provider drift into a read-time typed blocker', async () => {
    const verifier = new PawFeelDirectRepairBindingVerifier({
      sourceVerifier: {
        async verify() {
          return source;
        },
      },
      federation: new PawFeelDirectRepairFederation([
        {
          route: route('v2'),
          provider: {
            async resolveAuthority() {
              throw new Error('not used');
            },
            async verifyOutcome() {
              throw new Error('not used');
            },
          },
        },
      ]),
    });

    const status = await verifier.resolveStatus(projection);
    assert.equal(status.status, 'blocked');
    assert.equal(status.reasonCode, 'binding_mismatch');
    assert.ok(status.evidenceRefs.includes(binding.bindingRef.ownerStateRef));
  });

  it('accepts only a same-binding refs-only owner outcome', async () => {
    const resolver = harness();
    const outcome = await resolver.resolve({
      projection,
      actor: { kind: 'cat', id: 'opus' },
      bindingRef: binding.bindingRef,
      ownerOutcomeRef,
    });

    assert.equal(outcome.disposition, 'verified_changed');
    assert.deepEqual(outcome.taskTerminalRef, terminal.taskTerminalRef);
    assert.deepEqual(outcome.leaseTerminalRef, terminal.leaseTerminalRef);
    assert.equal('payload' in outcome, false);
  });
});
