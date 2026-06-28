import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';

/**
 * F192 Phase H 收尾 PR-2 R9 P1 (cloud): split from publish-verdict-capability-wakeup.test.js
 * to keep both files under AGENTS.md 350-line hard limit.
 *
 * Covers handler-level strict validation BEFORE isolated worktree creation:
 * - cloud R8 P2: sourceRefs.kind ↔ packet.domainId cross-check (mismatch → 400)
 * - 砚砚 R1 PR-2 review P2: PR-2 wired window selectors; AC-F8 later allows omitted sessionIds
 *   for unbiased window scan while trial-ids stays rejected until durable trial store exists.
 */

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-cw-strict-'));

function seedRegistry() {
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
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'bundles'), { recursive: true });
}

before(() => seedRegistry());
after(() => rmSync(root, { recursive: true, force: true }));

function buildPacket(overrides = {}) {
  return {
    id: 'vhp-strict-test',
    domainId: 'eval:capability-wakeup',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'strict validation test',
    harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:cat.signal'],
      sampleTraceRefs: ['trace:cat-001'],
    },
    dailyTrend: { window: '7d', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'strict', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-13T05:00:00.000Z', closureCondition: 'stable for 1 week' },
    counterarguments: ['alt'],
    ...overrides,
  };
}

describe('handlePublishVerdict strict validation (PR-2 R5/R8)', () => {
  // cloud R8 P2: cross-check sourceRefs.kind ↔ packet.domainId BEFORE per-kind validation
  it('rejects a2a-shape sourceRefs for capability-wakeup domain (cloud R8 P2)', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      {
        packet: buildPacket({ id: 'vhp-cw-wrong-kind' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
    assert.match(result.detail, /capability-wakeup-trial-window/);
  });

  it('rejects cw-shape sourceRefs for a2a domain (cloud R8 P2)', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      {
        packet: buildPacket({ id: 'vhp-a2a-wrong-kind', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['s1'],
        },
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
    assert.match(result.detail, /a2a-snapshot-attribution/);
  });

  // 砚砚 R1 PR-2 review P2: PR-2 wired only window/replay path
  it('rejects cw trial-ids selector at handler (PR-2 wired window only)', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      {
        packet: buildPacket({ id: 'vhp-cw-trial-ids-rejected' }),
        domain: 'eval:capability-wakeup',
        catId: 'opus-47',
        sourceRefs: { kind: 'capability-wakeup-trial-ids', trialIds: ['t1', 't2'] },
      },
    );
    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
    assert.match(result.detail, /capability-wakeup-trial-window/);
    assert.match(result.detail, /trial-ids/);
  });

  it('accepts cw window selector with omitted sessionIds through handler prevalidation (AC-F8)', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      {
        packet: buildPacket({ id: 'vhp-cw-no-sessions' }),
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
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
  });
});
