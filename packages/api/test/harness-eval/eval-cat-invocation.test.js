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
  sourceRefsKind: 'a2a-snapshot-attribution',
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

  it('builds instructions for eval:anchor-first (F236 Track-2 wired)', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:anchor-first',
        displayName: 'Anchor-first Eval',
        systemThreadId: 'thread_eval_anchor_first',
        sourceAdapter: 'anchor-first-eval',
        sourceRefsKind: 'anchor-telemetry-snapshot',
        handoffTargetResolver: { featureId: 'F236', ownerCatId: 'codex', threadLookup: 'feature-thread' },
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    });
    assert.equal(invocation.domainId, 'eval:anchor-first');
    assert.match(invocation.instructions, /anchor|preview|drill|open.rate/i);
  });

  it('builds instructions for eval:capability-wakeup domains', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:capability-wakeup',
        displayName: 'Capability Wakeup Eval',
        systemThreadId: 'thread_eval_capability_wakeup',
        sourceAdapter: 'capability-wakeup-eval',
        sourceRefsKind: 'capability-wakeup-trial-window',
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

  it('builds instructions for eval:sop with required changedFiles trace contract', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:sop',
        displayName: 'SOP Eval',
        systemThreadId: 'thread_eval_sop',
        sourceAdapter: 'sop-trace-eval',
        sourceRefsKind: 'sop-trace-eval',
        frequency: 'weekly',
        legacyScheduledTaskIds: [],
        handoffTargetResolver: { featureId: 'F192', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    });

    assert.equal(invocation.domainId, 'eval:sop');
    assert.match(invocation.instructions, /changedFiles/, 'eval:sop instructions must mention changedFiles');
    assert.match(invocation.instructions, /changedFileEvents/, 'eval:sop instructions must mention ordered file edits');
    assert.match(invocation.instructions, /eventNo|timestamp/, 'eval:sop instructions must mention ordering fields');
    assert.match(
      invocation.instructions,
      /empty array|empty.*\[\]/i,
      'eval:sop instructions must require an explicit empty changedFiles array when no files changed',
    );
    assert.match(
      invocation.instructions,
      /stdout|summary/,
      'eval:sop instructions must mention command output evidence',
    );
    assert.match(
      invocation.instructions,
      /freshness\.stale.*false|stale.*false/i,
      'eval:sop instructions must require fresh convention graph results',
    );
    assert.match(
      invocation.instructions,
      /targets/,
      'eval:sop instructions must include convention graph target coverage',
    );
    assert.match(
      invocation.instructions,
      /filePath/,
      'eval:sop instructions must include convention graph target filePath coverage',
    );
    assert.match(
      invocation.instructions,
      /packages\/mcp-server\/src\/tools\/callback-tools\.ts/,
      'eval:sop example must show target coverage for the changed convention surface',
    );
    assert.match(
      invocation.instructions,
      /pre-edit|pre.?edit/i,
      'eval:sop instructions must require pre-edit graph evidence',
    );
  });

  it('builds friction publish instructions with friction-rollup-snapshot selector (cloud R1 gap)', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:friction',
        displayName: 'Friction Eval',
        systemThreadId: 'thread_eval_friction',
        sourceAdapter: 'f245-friction-rollup',
        sourceRefsKind: 'friction-rollup-snapshot',
        frequency: 'weekly',
        legacyScheduledTaskIds: [],
        handoffTargetResolver: { featureId: 'F245', ownerCatId: 'opus-48', threadLookup: 'feature-thread' },
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    });

    assert.equal(invocation.domainId, 'eval:friction');
    // DOMAIN_INSTRUCTIONS friction analysis section
    assert.match(invocation.instructions, /friction rollup/i);
    // PUBLISH_VERDICT_INSTRUCTIONS_FRICTION — the publish selector shape. Cloud R1 gap:
    // friction was in DOMAIN_INSTRUCTIONS but missing from PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN,
    // so the enabled friction eval cat got no sourceRefs shape and could not drive the live sink.
    assert.match(
      invocation.instructions,
      /friction-rollup-snapshot/,
      'friction eval cat must get the friction-rollup-snapshot sourceRefs selector shape',
    );
    assert.match(invocation.instructions, /windowStartMs/, 'must describe the rollup window selector fields');
    assert.match(invocation.instructions, /Publish your verdict/, 'must include the common MANDATORY publish section');
    assert.match(invocation.instructions, /actionableCandidates/i);
    assert.match(invocation.instructions, /referenceOnly/i);
    assert.match(invocation.instructions, /followupDraft|propose_thread/i);
  });

  it('builds replayable publish instructions for eval:freshness', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:freshness',
        displayName: 'Freshness Gate Eval',
        systemThreadId: 'thread_eval_freshness',
        sourceAdapter: 'f254-freshness-replay',
        sourceRefsKind: 'freshness-closure-replay',
        frequency: 'weekly',
        legacyScheduledTaskIds: [],
        handoffTargetResolver: { featureId: 'F254', ownerCatId: 'codex', threadLookup: 'feature-thread' },
        enabled: true,
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    });

    assert.equal(invocation.domainId, 'eval:freshness');
    assert.match(invocation.instructions, /queued_seen/i);
    assert.match(invocation.instructions, /queued_handled/i);
    assert.match(invocation.instructions, /succeeded=handled|succeeded.*handled/i);
    assert.match(invocation.instructions, /telemetry gap/i);
    assert.match(invocation.instructions, /Publish your verdict/);
    assert.match(invocation.instructions, /freshness-closure-replay/);
    assert.match(invocation.instructions, /all eight AC-E9 fixtures are server-owned/i);
    assert.match(invocation.instructions, /callers cannot select a subset/i);
    assert.doesNotMatch(invocation.instructions, /fixtureIds/);
    assert.match(invocation.instructions, /healthy=false/);
  });

  it('eval:a2a instructions include grounding subdomain observation tokens (F167 Phase O)', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    // Key grounding tokens that must survive in the instruction string.
    // A later edit that drops any of these would break the eval→grounding pipeline
    // without failing any other test (the instruction is a prompt string, not executable code).
    assert.match(invocation.instructions, /grounding-phase-o/, 'must reference the grounding component ID');
    assert.match(invocation.instructions, /grounding\.check_total/, 'must reference shadow check counter');
    assert.match(invocation.instructions, /grounding\.verdict_total/, 'must reference verdict counter');
    assert.match(invocation.instructions, /grounding\.mismatch_sample_count/, 'must reference mismatch counter');
    assert.match(invocation.instructions, /groundingSampleEvidence/, 'must reference sample evidence field');
    assert.match(invocation.instructions, /telemetry gap/, 'must reference no-data telemetry gap guidance');
  });

  it('eval:a2a instructions include single-successor carrier migration tokens', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    assert.match(invocation.instructions, /successor\.single_target_multi_mention_rate/);
    assert.match(invocation.instructions, /successor\.unfenced_single_target_multi_mention/);
    assert.match(invocation.instructions, /successor\.action_fence_unavailable/);
    assert.match(invocation.instructions, /successor\.agent_key_action_rejected/);
    assert.match(invocation.instructions, /expected fail-closed/i);
    assert.match(invocation.instructions, /fix verdict/i);
  });

  it('eval:a2a instructions include Phase Q hold lifecycle zero-tolerance tokens', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    assert.match(invocation.instructions, /hold-lifecycle-phase-q/, 'must reference the Phase Q component ID');
    assert.match(
      invocation.instructions,
      /hold_lifecycle\.event_retired_total/,
      'must reference event-backed retirement activation',
    );
    assert.match(
      invocation.instructions,
      /hold_lifecycle\.stale_wake_suppressed_total/,
      'must reference stale wake suppression activation',
    );
    assert.match(
      invocation.instructions,
      /hold_lifecycle\.expired_after_satisfied_total/,
      'must reference the expired-after-satisfied invariant',
    );
    assert.match(invocation.instructions, /zero-tolerance/i, 'must call the invariant zero-tolerance');
    assert.match(invocation.instructions, /any nonzero/i, 'must explain that any nonzero value is actionable');
  });

  it('eval:a2a instructions include F177 event-backed routing zero-tolerance tokens', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    assert.match(invocation.instructions, /event-backed-routing-exit/);
    assert.match(invocation.instructions, /event_wait\.bypass_total/);
    assert.match(invocation.instructions, /event_wait\.rejected_stale_total/);
    assert.match(invocation.instructions, /event_wait\.rejected_unrelated_total/);
    assert.match(invocation.instructions, /event_wait\.rejected_uncovered_total/);
    assert.match(invocation.instructions, /event_wait\.rejected_query_failed_total/);
    assert.match(invocation.instructions, /event_wait\.rejected_other_total/);
    assert.match(invocation.instructions, /event_wait\.redundant_hold_prevented_total/);
    assert.match(invocation.instructions, /event_wait\.false_bypass_total/);
    assert.match(invocation.instructions, /zero-tolerance/i);
    assert.match(invocation.instructions, /any nonzero/i);
  });

  it('eval:a2a instructions bind Phase T correctness to the authoritative disagreement denominator', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    assert.match(invocation.instructions, /turn-custody-stop-gate/);
    assert.match(invocation.instructions, /turn_custody\.old_only_block_total/);
    assert.match(invocation.instructions, /turn_custody\.new_only_block_total/);
    assert.match(invocation.instructions, /turn_custody\.unknown_legacy_rate/);
    assert.match(invocation.instructions, /projected_block_increase_total only as behavior-delta observation/i);
    assert.match(invocation.instructions, /justified \+ unjustified \+ unexplained/i);
    assert.match(invocation.instructions, /bounded trace samples explain rows but never substitute/i);
  });

  it('eval:a2a instructions include counter rate denominator tokens (F167 sibling-PR)', () => {
    const invocation = buildEvalCatInvocation({
      domain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });

    // Counter baseline awareness tokens — must survive so eval cats pick the
    // right denominator for counter rate (counterWindow, not window). Without
    // these in the instruction string, eval cats silently divide fresh counters
    // by hydrated 24h trace windows and report false-negative "low activity".
    assert.match(
      invocation.instructions,
      /counterWindow/,
      'must reference bundle JSON counterWindow field (camelCase)',
    );
    assert.match(
      invocation.instructions,
      /counter_window/,
      'must also reference raw YAML counter_window field (snake_case) — R5 cloud P2: eval cats reading raw snapshot YAML need the snake_case alias or they miss the denominator',
    );
    assert.match(invocation.instructions, /denominator/, 'must explain rate denominator selection');
    assert.match(invocation.instructions, /reset to 0/i, 'must explain why counters reset on restart');
    assert.match(
      invocation.instructions,
      /downgrade.*confidence|confidence.*downgrade/i,
      'must guide confidence downgrade on short counter window',
    );
  });

  it('includes registry fixture refs in the eval-cat context', () => {
    const invocation = buildEvalCatInvocation({
      domain: {
        ...domain,
        domainId: 'eval:capability-wakeup',
        displayName: 'Capability Wakeup Eval',
        systemThreadId: 'thread_eval_capability_wakeup',
        sourceAdapter: 'capability-wakeup-eval',
        sourceRefsKind: 'capability-wakeup-trial-window',
        frequency: 'weekly',
        legacyScheduledTaskIds: [],
        handoffTargetResolver: { featureId: 'F203', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
        fixtures: [
          {
            id: 'source-hygiene-memu-echo-chamber',
            featureId: 'F218',
            path: 'docs/harness-feedback/fixtures/source-hygiene-memu-echo-chamber.md',
            skill: 'source-audit',
            signal: 'high-risk external claim without provenance',
          },
        ],
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    });

    assert.deepEqual(invocation.context.fixtures, [
      {
        id: 'source-hygiene-memu-echo-chamber',
        featureId: 'F218',
        path: 'docs/harness-feedback/fixtures/source-hygiene-memu-echo-chamber.md',
        skill: 'source-audit',
        signal: 'high-risk external claim without provenance',
      },
    ]);
  });
});
