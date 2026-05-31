import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEvalCatInvocation } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';

const domain = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  systemThreadId: 'thread_eval_a2a',
  evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
  frequency: 'daily',
  sourceAdapter: 'f167-runtime-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['harness-fit-digest'],
  handoffTargetResolver: { featureId: 'F167', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
};

describe('Eval cat invocation packet', () => {
  it('builds a domain-thread invocation with longitudinal context', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: ['docs/harness-feedback/snapshots/2026-05-20-F167.json'],
      verdictRefs: ['docs/harness-feedback/verdicts/2026-05-20-a2a.md'],
      legacyCleanup: { status: 'dry_run_ready', reportRef: 'docs/harness-feedback/migrations/a2a.md' },
    });

    assert.equal(invocation.domainId, 'eval:a2a');
    assert.equal(invocation.targetThreadId, 'thread_eval_a2a');
    assert.equal(invocation.evalCat.catId, 'codex');
    assert.match(invocation.instructions, /day-over-day/);
    assert.deepEqual(invocation.context.trendRefs, ['docs/harness-feedback/snapshots/2026-05-20-F167.json']);
    assert.equal(invocation.context.legacyCleanup.status, 'dry_run_ready');
  });

  it('refuses to build without a domain thread id', () => {
    assert.throws(
      () =>
        buildEvalCatInvocation({
          domain: { ...domain, systemThreadId: '' },
          trendRefs: [],
          verdictRefs: [],
          legacyCleanup: { status: 'not_checked' },
        }),
      /systemThreadId/,
    );
  });

  it('includes old scheduled-task ids for double-trigger analysis', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    assert.deepEqual(invocation.context.legacyScheduledTaskIds, ['harness-fit-digest']);
    assert.match(invocation.instructions, /legacy scheduled task/);
  });

  it('builds instructions for eval:capability-wakeup domains', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:capability-wakeup',
        displayName: 'Capability Wakeup Eval',
        systemThreadId: 'thread_eval_capability_wakeup',
        sourceAdapter: 'capability-wakeup-eval',
        frequency: 'weekly',
        legacyScheduledTaskIds: [],
        handoffTargetResolver: { featureId: 'F203', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    });

    assert.equal(invocation.domainId, 'eval:capability-wakeup');
    assert.equal(invocation.targetThreadId, 'thread_eval_capability_wakeup');
    assert.match(invocation.instructions, /capability wakeup/i);
    assert.match(invocation.instructions, /miss/i);
  });
});
