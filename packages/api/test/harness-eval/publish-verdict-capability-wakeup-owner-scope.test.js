import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCapabilityWakeupGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/capability-wakeup-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-cw-owner-'));

before(() => {
  const domainsDir = join(root, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'bundles'), { recursive: true });
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
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildCwPacket() {
  return {
    id: 'vhp-cw-owner-scope',
    domainId: 'eval:capability-wakeup',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'cw owner scope test phenomenon',
    harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:cat.signal'],
      sampleTraceRefs: ['trace:cat-001'],
    },
    dailyTrend: { window: '7d', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'cw owner', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-13T05:00:00.000Z', closureCondition: 'stable for 1 week' },
    counterarguments: ['alternative interpretation'],
  };
}

describe('handlePublishVerdict capability-wakeup owner scope', () => {
  it('returns 401 before resolving capability-wakeup evidence without ownerUserId', async () => {
    let providerCalled = false;
    const provider = {
      resolve: async () => {
        providerCalled = true;
        return [];
      },
    };
    const cwGenerator = createCapabilityWakeupGeneratorAdapter(provider);
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        await opts.stage(join(root, '..', 'cw-owner-iso'));
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };

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
        },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'unauthenticated');
    assert.equal(providerCalled, false);
  });
});
