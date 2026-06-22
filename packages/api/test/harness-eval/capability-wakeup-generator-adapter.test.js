import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCapabilityWakeupGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/capability-wakeup-generator-adapter.js';

/**
 * F192 Phase H 收尾 PR-2 — capability-wakeup generator adapter tests.
 *
 * Adapter behaviour:
 *   - Discriminator: rejects non-capability-wakeup-trial-window sourceRefs
 *   - Validation: rejects bad selector (delegates to PR-1a validator)
 *   - Provider: calls provider.resolve(selector) for trials
 *   - Empty trials: throws no_trials_in_window (caller treats as 4xx upstream)
 *   - Submit: passes packet to generator as submittedPacket (砚砚 R8 P1)
 *   - Registry: loads EvalDomainRegistryEntry from isolated harness root
 */

function seedDomainRegistry(harnessFeedbackRoot) {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  writeFileSync(
    join(domainsDir, 'eval-capability-wakeup.yaml'),
    `domainId: eval:capability-wakeup
displayName: Capability Wakeup Eval
systemThreadId: thread_eval_capability_wakeup
evalCat:
  catId: opus-47
  handle: "@opus47"
  model: claude-opus-4-7
frequency: weekly
sourceAdapter: capability-wakeup-eval
sourceRefsKind: capability-wakeup-trial-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F203
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
`,
  );
}

function buildSubmittedPacket(overrides = {}) {
  return {
    id: 'vhp-cw-adapter-test',
    domainId: 'eval:capability-wakeup',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'cw adapter test phenomenon',
    harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:cat.signal'],
      sampleTraceRefs: ['trace:cat-001'],
    },
    dailyTrend: { window: '7d', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'cw test', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-13T05:00:00.000Z', closureCondition: 'stable for 1 week' },
    counterarguments: ['alternative interpretation'],
    ...overrides,
  };
}

function buildClassifiedTrial(overrides = {}) {
  return {
    ruleId: 'rich-messaging-long-structured-text',
    capability: 'rich-messaging',
    sessionId: 'session-1',
    threadId: 'thread-1',
    catId: 'gpt52',
    window: { currentInvocationId: 'inv-1', nextInvocationId: 'inv-2', invocationIndex: 0 },
    eventNoSpan: { start: 0, end: 1 },
    timeSpan: { startMs: 1780000000000, endMs: 1780000000001 },
    outcome: 'miss',
    zeroFrictionDefault: true,
    opportunityEvidence: ['token_count=120', 'structured_signals=7'],
    usageEvidence: [],
    label: 'cognitive',
    ...overrides,
  };
}

describe('createCapabilityWakeupGeneratorAdapter', () => {
  it('rejects sourceRefs with wrong kind (a2a)', async () => {
    const provider = { resolve: async () => [] };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket(),
        { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' },
      ),
      /capability_wakeup_adapter_wrong_kind/,
    );
  });

  it('rejects sourceRefs with missing kind', async () => {
    const provider = { resolve: async () => [] };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);
    await assert.rejects(
      adapter(buildSubmittedPacket(), {}, { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' }),
      /capability_wakeup_adapter_wrong_kind/,
    );
  });

  it('delegates selector validation to PR-1a validator (rejects invalid windowEndMs)', async () => {
    const provider = { resolve: async () => [] };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket(),
        {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 100,
          windowEndMs: 100, // invalid: must be > windowStartMs
        },
        { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' },
      ),
      /invalid_source_ref.*windowEndMs/,
    );
  });

  it('throws no_trials_in_window when provider returns empty', async () => {
    const provider = { resolve: async () => [] };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket(),
        {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live', ownerUserId: 'default-user' },
      ),
      /no_trials_in_window.*rich-messaging/,
    );
  });

  it('requires ownerUserId before resolving provider', async () => {
    let called = false;
    const provider = {
      resolve: async () => {
        called = true;
        return [buildClassifiedTrial()];
      },
    };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket(),
        {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        { harnessFeedbackRoot: '/tmp/iso', liveHarnessFeedbackRoot: '/tmp/live' },
      ),
      /owner_user_required.*publish/,
    );
    assert.equal(called, false);
  });

  it('throws unknown_domain when packet.domainId not in registry', async () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'cw-adapter-unknown-')); // empty domains dir
    const provider = { resolve: async () => [buildClassifiedTrial()] };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);
    await assert.rejects(
      adapter(
        buildSubmittedPacket({ domainId: 'eval:capability-wakeup' }),
        {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        { harnessFeedbackRoot, liveHarnessFeedbackRoot: '/tmp/live', ownerUserId: 'default-user' },
      ),
      /unknown_domain.*eval:capability-wakeup/,
    );
  });

  it('happy path: passes packet+trials+domain to generator and returns artifact paths', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cw-adapter-happy-repo-'));
    const harnessFeedbackRoot = join(repoRoot, 'docs', 'harness-feedback');
    seedDomainRegistry(harnessFeedbackRoot);
    let resolveCalledWith = null;
    let resolveScope = null;
    const provider = {
      resolve: async (selector, scope) => {
        resolveCalledWith = selector;
        resolveScope = scope;
        return [buildClassifiedTrial()];
      },
    };
    const adapter = createCapabilityWakeupGeneratorAdapter(provider);

    const packet = buildSubmittedPacket();
    const selector = {
      kind: 'capability-wakeup-trial-window',
      capability: 'rich-messaging',
      windowStartMs: 0,
      windowEndMs: 9999999999999,
      sessionIds: ['session-1'],
    };

    const result = await adapter(packet, selector, {
      harnessFeedbackRoot,
      liveHarnessFeedbackRoot: '/tmp/live-unused-for-cw',
      ownerUserId: 'default-user',
    });

    assert.deepEqual(resolveCalledWith, selector, 'adapter passes selector to provider unchanged');
    assert.deepEqual(resolveScope, { ownerUserId: 'default-user' });
    assert.match(result.verdictPath, /verdicts\/vhp-cw-adapter-test\.md$/);
    assert.match(result.bundleDir, /bundles\/vhp-cw-adapter-test$/);
    // cloud R3 P1: cw generator writes raw inputs (trials.json + summary.json) at
    // `<repoRoot>/generated/capability-wakeup/<verdictId>/` referenced in provenance.json.
    // Adapter MUST forward rawInputDir via extraStagedPaths or auto-PR omits raw inputs
    // and reviewers/main can't audit/replay.
    assert.ok(Array.isArray(result.extraStagedPaths), 'extraStagedPaths must be array');
    assert.equal(result.extraStagedPaths.length, 1, 'expected exactly one extra staged path (rawInputDir)');
    assert.equal(
      result.extraStagedPaths[0],
      join(repoRoot, 'generated', 'capability-wakeup', 'vhp-cw-adapter-test'),
      'extra path must be raw input dir inside the derived repo root',
    );
  });
});
