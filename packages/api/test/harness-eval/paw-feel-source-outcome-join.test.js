import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PawFeelContinuingResponsibilityResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/continuation/follow-up-resolver.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const ref = (ownerFeatureId, ownerStateRef, version) => ({
  ownerFeatureId,
  ownerStateRef,
  ...(version ? { version } : {}),
});

function base(signalId, state, overrides = {}) {
  return {
    signalId,
    sourceMessageId: `message-${signalId}`,
    sourceThreadId: 'thread-source',
    sourceCatId: 'codex-sol',
    markerDigest: 'a'.repeat(64),
    sameDigestOrdinal: 0,
    markerIndex: 0,
    state,
    sequence: 2,
    discoveredAt: '2026-09-01T00:00:00.000Z',
    lastTransitionAt: '2026-09-01T00:00:01.000Z',
    backfilled: false,
    captureMethod: 'typed',
    captureAssessment: 'confirmed',
    ...overrides,
  };
}

const binding = {
  schemaVersion: 1,
  bindingRef: ref('F278', `paw-feel-direct-repair-binding:sha256:${'b'.repeat(64)}`),
  sourceSignalRef: ref('F278', 'paw-feel-signal:canonical', `${'a'.repeat(64)}:0`),
  sourceToolRef: ref('F167', 'mcp-tool:cat_cafe_hold_ball'),
  providerId: 'f167-owner',
  providerVersion: 'v1',
  providerRouteRef: ref('F278', `paw-feel-direct-repair-route:sha256:${'c'.repeat(64)}`),
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

function fix(overrides = {}) {
  return base('canonical', 'fix', {
    ownerCatId: 'opus',
    taskId: 'task-1',
    actionLeaseRef: { leaseId: 'lease-1', generation: 2 },
    custodyEvidenceRef: 'action-lease:lease-1:generation:2',
    directRepairBinding: binding,
    ...overrides,
  });
}

describe('F313 source outcome and duplicate follow-up join', () => {
  it('keeps a terminal task open as done_unverified and projects it through duplicates', async () => {
    const canonical = fix();
    const duplicate = base('duplicate', 'duplicate', { duplicateOf: canonical.signalId });
    const projections = new Map([
      [canonical.signalId, canonical],
      [duplicate.signalId, duplicate],
    ]);
    const resolver = new PawFeelContinuingResponsibilityResolver({
      repairProgressResolver: {
        async resolve() {
          return { status: 'done_unverified', evidenceRefs: ['task:task-1:done', 'lease:lease-1:succeeded'] };
        },
      },
    });

    const direct = await resolver.resolve({ projection: canonical, projectionsBySignalId: projections, nowMs: NOW });
    const followed = await resolver.resolve({ projection: duplicate, projectionsBySignalId: projections, nowMs: NOW });

    assert.equal(direct.resolution, 'open');
    assert.equal(direct.continuation.kind, 'done_unverified');
    assert.equal(followed.resolution, 'open');
    assert.equal(followed.continuation.kind, 'done_unverified');
    assert.equal(followed.continuation.canonicalSignalId, canonical.signalId);
  });

  it('projects a drifted direct binding as an explicit open route blocker', async () => {
    const source = fix();
    const resolver = new PawFeelContinuingResponsibilityResolver({
      directRepairBindingResolver: {
        async resolveStatus() {
          return {
            status: 'blocked',
            reasonCode: 'binding_mismatch',
            evidenceRefs: ['paw-feel-direct-repair-binding:one', 'paw-feel-direct-repair-route:v2'],
          };
        },
      },
      repairProgressResolver: {
        async resolve() {
          return { status: 'done_unverified', evidenceRefs: ['task:task-1:done'] };
        },
      },
    });

    const issue = await resolver.resolve({
      projection: source,
      projectionsBySignalId: new Map([[source.signalId, source]]),
      nowMs: NOW,
    });

    assert.equal(issue.resolution, 'open');
    assert.equal(issue.continuation.kind, 'direct_route_blocked');
    assert.equal(issue.continuation.reasonCode, 'binding_mismatch');
  });

  it('resolves only after a refs-only owner-verified outcome and projects that truth through duplicates', async () => {
    const canonical = fix({
      repairOutcome: {
        schemaVersion: 1,
        bindingRef: binding.bindingRef,
        taskTerminalRef: ref('F310', 'task-terminal:task-1', '7'),
        leaseTerminalRef: ref('F167', 'action-successor-terminal:lease-1', '2'),
        ownerOutcomeRef: ref('F167', 'owner-outcome:repair-1', '1'),
        verificationRefs: [ref('F167', 'verification:loaded-main', 'abc')],
        disposition: 'verified_changed',
      },
      lastTransitionAt: '2026-09-07T01:00:00.000Z',
    });
    const duplicate = base('duplicate', 'duplicate', { duplicateOf: canonical.signalId });
    const projections = new Map([
      [canonical.signalId, canonical],
      [duplicate.signalId, duplicate],
    ]);
    const resolver = new PawFeelContinuingResponsibilityResolver();

    const direct = await resolver.resolve({ projection: canonical, projectionsBySignalId: projections, nowMs: NOW });
    const followed = await resolver.resolve({ projection: duplicate, projectionsBySignalId: projections, nowMs: NOW });

    assert.equal(direct.resolution, 'resolved');
    assert.equal(direct.continuation.kind, 'verified_outcome');
    for (const evidenceRef of [
      binding.sourceSignalRef.ownerStateRef,
      binding.sourceToolRef.ownerStateRef,
      binding.providerRouteRef.ownerStateRef,
      binding.resolvedActionRef.ownerStateRef,
      binding.actionScopeRef.ownerStateRef,
      binding.ownerAuthorizationRef.ownerStateRef,
      binding.targetVersionRef.ownerStateRef,
      binding.outcomeVerifierRef.ownerStateRef,
      canonical.repairOutcome.taskTerminalRef.ownerStateRef,
      canonical.repairOutcome.leaseTerminalRef.ownerStateRef,
      canonical.repairOutcome.ownerOutcomeRef.ownerStateRef,
      canonical.repairOutcome.verificationRefs[0].ownerStateRef,
    ]) {
      assert.ok(direct.continuation.evidenceRefs.includes(evidenceRef), `missing ${evidenceRef}`);
    }
    assert.equal(followed.resolution, 'resolved');
    assert.equal(followed.continuation.canonicalSignalId, canonical.signalId);
    assert.equal(followed.resolvedAt, '2026-09-07T01:00:00.000Z');
  });

  it('keeps the ultimate canonical signal across a multi-hop duplicate chain', async () => {
    const canonical = fix();
    const middle = base('middle', 'duplicate', { duplicateOf: canonical.signalId });
    const leaf = base('leaf', 'duplicate', { duplicateOf: middle.signalId });
    const projections = new Map([
      [canonical.signalId, canonical],
      [middle.signalId, middle],
      [leaf.signalId, leaf],
    ]);
    const resolver = new PawFeelContinuingResponsibilityResolver({
      repairProgressResolver: {
        async resolve() {
          return { status: 'active', evidenceRefs: ['task:task-1'] };
        },
      },
    });

    const followed = await resolver.resolve({ projection: leaf, projectionsBySignalId: projections, nowMs: NOW });
    assert.equal(followed.continuation.canonicalSignalId, canonical.signalId);
    assert.ok(followed.continuation.evidenceRefs.includes(middle.signalId));
    assert.ok(followed.continuation.evidenceRefs.includes(canonical.signalId));
  });

  it('can resolve from existing F266 outcome refs without copying its payload', async () => {
    const source = base('approval-source', 'seen');
    const resolver = new PawFeelContinuingResponsibilityResolver({
      sourceCaseResolver: {
        async resolveFollowUp() {
          return {
            resolution: 'resolved',
            resolvedAt: '2026-09-07T02:00:00.000Z',
            continuation: {
              kind: 'verified_outcome',
              evidenceRefs: ['case:one', 'outcome:one', 'freshness:one'],
            },
          };
        },
      },
    });
    const issue = await resolver.resolve({
      projection: source,
      projectionsBySignalId: new Map([[source.signalId, source]]),
      nowMs: NOW,
    });

    assert.deepEqual(issue.continuation, {
      kind: 'verified_outcome',
      evidenceRefs: ['case:one', 'outcome:one', 'freshness:one'],
    });
    assert.equal(issue.resolution, 'resolved');
    assert.equal(issue.resolvedAt, '2026-09-07T02:00:00.000Z');
  });
});
