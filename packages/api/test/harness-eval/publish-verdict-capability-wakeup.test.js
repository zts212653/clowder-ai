import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCapabilityWakeupGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/capability-wakeup-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';

/**
 * F192 Phase H 收尾 PR-2 — end-to-end test: handler dispatches to capability-wakeup
 * generator adapter via deps.generator (route layer responsibility — eval-hub.ts:311
 * selects from opts.verdictGenerators[domainId]).
 *
 * Validates:
 *   - Handler accepts capability-wakeup domain (no longer 501 by hardcoded check)
 *   - Handler passes raw sourceRefs (cw selector) to generator
 *   - Generator dispatched correctly via deps.generator (single generator per call)
 *   - 501 still returned when domain has NO generator (e.g. eval:memory)
 *   - cw verdict path returned in repo-relative form
 */

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-cw-e2e-'));

function seedRegistryAndDirs() {
  // Seed eval-domains registry
  const domainsDir = join(root, 'eval-domains');
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
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
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
  // cloud R8 P2 regression test needs eval:a2a in registry too (kind-mismatch
  // check fires AFTER domain registry lookup so wrong-domain → wrong-error).
  writeFileSync(
    join(domainsDir, 'eval-a2a.yaml'),
    `domainId: eval:a2a
displayName: A2A Eval
systemThreadId: thread_eval_a2a
evalCat:
  catId: codex
  handle: "@codex"
  model: gpt-5.5
frequency: daily
sourceAdapter: f167-runtime-eval
sourceRefsKind: a2a-snapshot-attribution
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F167
  ownerCatId: codex
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
`,
  );
  // Seed empty bundles/verdicts dirs so live-tree dup check doesn't false-positive
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'bundles'), { recursive: true });
}

before(() => {
  seedRegistryAndDirs();
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildCwPacket(overrides = {}) {
  return {
    id: 'vhp-cw-e2e-test',
    domainId: 'eval:capability-wakeup',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'cw e2e test phenomenon',
    harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:cat.signal'],
      sampleTraceRefs: ['trace:cat-001'],
    },
    dailyTrend: { window: '7d', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'cw e2e', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-13T05:00:00.000Z', closureCondition: 'stable for 1 week' },
    counterarguments: ['alternative interpretation'],
    ...overrides,
  };
}

function buildClassifiedTrial() {
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
  };
}

describe('handlePublishVerdict end-to-end with capability-wakeup generator', () => {
  it('happy path: handler dispatches to cw adapter, returns verdict path + commit/PR', async () => {
    const provider = { resolve: async () => [buildClassifiedTrial()] };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(provider);
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        // Stage callback runs generator inside isolated worktree.
        // For e2e, run stage against the LIVE root so generator can find registry + write artifacts.
        await opts.stage(join(root, '..', 'cw-e2e-iso-stub'));
        return { commitSha: 'cw-sha-1234', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9000' };
      },
    };
    // Pre-create the isolated stub so cw generator's loadDomains() works
    const isoStub = join(root, '..', 'cw-e2e-iso-stub');
    mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
    writeFileSync(
      join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-capability-wakeup.yaml'),
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
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
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

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket(),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.commitSha, 'cw-sha-1234');
    assert.equal(result.prUrl, 'https://github.com/zts212653/clowder-ai/pull/9000');
    // 砚砚 R12 P2 cloud: repo-relative paths (deterministic from packet.id)
    assert.equal(result.verdictPath, 'docs/harness-feedback/verdicts/vhp-cw-e2e-test.md');
    assert.equal(result.bundleDir, 'docs/harness-feedback/bundles/vhp-cw-e2e-test');

    // cleanup
    rmSync(isoStub, { recursive: true, force: true });
  });

  // PR-2 R9 P1: handler-level strict validation tests (R5 + R8) extracted to
  // `publish-verdict-capability-wakeup-strict-validation.test.js` (AGENTS.md 350-line limit).

  // cloud R5 P2 (PR-2): provider throws session_not_found / cw adapter throws
  // no_trials_in_window for user-correctable input errors. Handler must map to 4xx
  // (404), not 500 generator_failed.
  it('returns 404 session_not_found when provider can not resolve sessionId', async () => {
    const provider = {
      resolve: async () => {
        throw new Error('session_not_found: stale-session-id');
      },
    };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(provider);
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        await opts.stage(join(root, '..', 'cw-e2e-nofound-iso'));
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };
    mkdirSync(join(root, '..', 'cw-e2e-nofound-iso', 'docs', 'harness-feedback'), { recursive: true });

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket({ id: 'vhp-cw-nofound' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['stale-session-id'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 404);
    assert.equal(result.error, 'session_not_found');
    assert.match(result.detail, /stale-session-id/);

    rmSync(join(root, '..', 'cw-e2e-nofound-iso'), { recursive: true, force: true });
  });

  it('returns 404 no_trials_in_window when provider yields zero trials (PR-2 4xx mapping)', async () => {
    const emptyProvider = { resolve: async () => [] };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(emptyProvider);
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        await opts.stage(join(root, '..', 'cw-e2e-empty2-iso'));
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };
    mkdirSync(join(root, '..', 'cw-e2e-empty2-iso', 'docs', 'harness-feedback'), { recursive: true });

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket({ id: 'vhp-cw-empty2' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 404);
    assert.equal(result.error, 'no_trials_in_window');

    rmSync(join(root, '..', 'cw-e2e-empty2-iso'), { recursive: true, force: true });
  });

  it('returns 501 when no generator wired for capability-wakeup domain', async () => {
    // Use eval:capability-wakeup (registered in this test's seed) but omit deps.generator.
    // Pre-validation (cw selector) passes; catId 'opus-47' passes allowlist; then no
    // generator → 501. This proves the route-layer dispatch contract: handler depends
    // on deps.generator presence, not on domain hardcoding.
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root /* generator omitted */ },
      {
        packet: buildCwPacket({ id: 'vhp-cw-no-gen' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
    assert.match(result.detail, /eval:capability-wakeup/);
  });

  it('returns 404 when cw provider yields zero trials (no_trials_in_window propagates)', async () => {
    const emptyProvider = { resolve: async () => [] };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(emptyProvider);
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        await opts.stage(join(root, '..', 'cw-e2e-empty-iso'));
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };
    mkdirSync(join(root, '..', 'cw-e2e-empty-iso', 'docs', 'harness-feedback'), { recursive: true });

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: cwGenerator },
      {
        packet: buildCwPacket({ id: 'vhp-cw-empty' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        ownerUserId: 'default-user',
      },
    );
    assert.ok('error' in result);
    // cloud R5 P2 (PR-2): updated from 500 generator_failed → 404 no_trials_in_window
    // (user-correctable input error, not server failure).
    assert.equal(result.status, 404);
    assert.equal(result.error, 'no_trials_in_window');
    assert.match(result.detail, /no_trials_in_window/);

    rmSync(join(root, '..', 'cw-e2e-empty-iso'), { recursive: true, force: true });
  });
});
