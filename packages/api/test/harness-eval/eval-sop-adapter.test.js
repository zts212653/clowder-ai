import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSopVerdictHandoff,
  reevalSopVerdict,
  runSopEval,
} from '../../dist/infrastructure/harness-eval/sop/eval-sop-adapter.js';

const sopDomain = {
  domainId: 'eval:sop',
  displayName: 'SOP Compliance Eval',
  systemThreadId: 'thread_eval_sop',
  evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
  frequency: 'weekly',
  sourceAdapter: 'sop-trace-eval',
  sourceRefsKind: 'sop-trace-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: {
    featureId: 'F192',
    ownerCatId: 'opus',
    threadLookup: 'feature-thread',
  },
  sla: { acknowledgeHours: 48, reevalWithinHours: 336 },
};

const violationResult = {
  ruleId: 'merge-cross-review',
  status: 'violation',
  violation: {
    ruleId: 'merge-cross-review',
    stageId: 'merge',
    kind: 'hard_rule',
    severity: 'blocker',
    predicateType: 'handle_check',
    message: 'reviewer "opus" is the same as author "opus"',
    traceAnchor: 'handles:author=opus,reviewer=opus',
  },
};

const passResult = { ruleId: 'merge-gate-pass', status: 'pass' };
const skippedResult = { ruleId: 'merge-manual-check', status: 'skipped', reason: 'manual verification required' };

describe('eval:sop verdict adapter (AC-E21)', () => {
  it('produces fix verdict when violations exist', () => {
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-001',
      evalResults: [violationResult, passResult, skippedResult],
    });

    assert.equal(packet.domainId, 'eval:sop');
    assert.equal(packet.verdict, 'fix');
    assert.ok(packet.id.startsWith('vhp_eval_sop_'));
    assert.ok(packet.phenomenon.includes('merge-cross-review'));
    assert.equal(packet.harnessUnderEval.featureId, 'F192');
    assert.equal(packet.harnessUnderEval.componentId, 'development');
    assert.ok(packet.ownerAsk.requestedAction.includes('merge-cross-review'));
    assert.ok(packet.counterarguments.length >= 1);
  });

  it('produces keep_observe verdict when no violations', () => {
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-002',
      evalResults: [passResult, skippedResult],
    });

    assert.equal(packet.verdict, 'keep_observe');
    assert.ok(packet.phenomenon.includes('No SOP violations'));
  });

  it('includes all violation trace anchors in evidence sampleTraceRefs', () => {
    const secondViolation = {
      ruleId: 'merge-redis-6399',
      status: 'violation',
      violation: {
        ruleId: 'merge-redis-6399',
        stageId: 'merge',
        kind: 'hard_rule',
        severity: 'blocker',
        predicateType: 'env_check',
        message: 'env REDIS_URL=":6399" must NOT include ":6399"',
        traceAnchor: 'env:REDIS_URL=redis://localhost:6399',
      },
    };
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-003',
      evalResults: [violationResult, secondViolation, passResult],
    });

    assert.equal(packet.evidencePacket.sampleTraceRefs.length, 2);
    assert.ok(packet.evidencePacket.sampleTraceRefs.includes('handles:author=opus,reviewer=opus'));
    assert.ok(packet.evidencePacket.sampleTraceRefs.includes('env:REDIS_URL=redis://localhost:6399'));
  });

  it('rejects non eval:sop domain', () => {
    const wrongDomain = { ...sopDomain, domainId: 'eval:a2a' };
    assert.throws(
      () =>
        buildSopVerdictHandoff({
          domain: wrongDomain,
          sopDefinitionId: 'development',
          sessionId: 'session-004',
          evalResults: [passResult],
        }),
      /eval:sop/,
    );
  });

  it('rejects empty evalResults', () => {
    assert.throws(
      () =>
        buildSopVerdictHandoff({
          domain: sopDomain,
          sopDefinitionId: 'development',
          sessionId: 'session-005',
          evalResults: [],
        }),
      /empty/i,
    );
  });

  it('severity: worst blocker reported in phenomenon', () => {
    const warnViolation = {
      ruleId: 'review-naming',
      status: 'violation',
      violation: {
        ruleId: 'review-naming',
        stageId: 'review',
        kind: 'pitfall',
        severity: 'warn',
        predicateType: 'command_pattern',
        message: 'naming convention not followed',
        traceAnchor: 'commands:[pnpm test]',
      },
    };
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-006',
      evalResults: [violationResult, warnViolation, passResult],
    });

    // blocker is worst → phenomenon should mention it
    assert.ok(packet.phenomenon.includes('blocker'));
  });

  it('daily trend reports violation counts per severity', () => {
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-007',
      evalResults: [violationResult, passResult, skippedResult],
    });

    assert.equal(packet.dailyTrend.current.violations_blocker, 1);
    assert.equal(packet.dailyTrend.current.violations_warn, 0);
    assert.equal(packet.dailyTrend.current.rules_passed, 1);
    assert.equal(packet.dailyTrend.current.rules_skipped, 1);
  });
});

describe('AC-E21: rule-owner handoff target resolution', () => {
  const violationWithOwner = {
    ruleId: 'review-no-self-review',
    status: 'violation',
    violation: {
      ruleId: 'review-no-self-review',
      stageId: 'review',
      kind: 'hard_rule',
      severity: 'blocker',
      predicateType: 'handle_check',
      message: 'reviewer "opus" is the same as author "opus"',
      traceAnchor: 'handles:author=opus,reviewer=opus',
      owner: { type: 'stage_suggested_skill', skill: 'request-review' },
    },
  };

  const warnViolationDifferentOwner = {
    ruleId: 'impl-design-gate',
    status: 'violation',
    violation: {
      ruleId: 'impl-design-gate',
      stageId: 'impl',
      kind: 'pitfall',
      severity: 'warn',
      predicateType: 'manual_only',
      message: 'skipped design gate',
      traceAnchor: 'commands:[git commit]',
      owner: { type: 'stage_suggested_skill', skill: 'writing-plans' },
    },
  };

  it('routes ownerAsk to resolved rule owner when resolver provided', () => {
    const resolver = (owner) => {
      if (owner.skill === 'request-review') {
        return { featureId: 'F200', ownerCatId: 'gpt52' };
      }
      return undefined;
    };

    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-owner-resolve',
      evalResults: [violationWithOwner, passResult],
      resolveRuleHandoffTarget: resolver,
    });

    assert.equal(packet.ownerAsk.targetFeatureId, 'F200');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'gpt52');
  });

  it('falls back to domain-level when no resolver provided', () => {
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-owner-fallback',
      evalResults: [violationWithOwner, passResult],
      // no resolveRuleHandoffTarget
    });

    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
  });

  it('falls back to domain-level when resolver returns undefined', () => {
    const resolver = () => undefined;
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-owner-undefined',
      evalResults: [violationWithOwner, passResult],
      resolveRuleHandoffTarget: resolver,
    });

    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
  });

  it('resolves primary owner from worst-severity violation', () => {
    const resolver = (owner) => {
      if (owner.skill === 'request-review') {
        return { featureId: 'F200', ownerCatId: 'gpt52' };
      }
      if (owner.skill === 'writing-plans') {
        return { featureId: 'F201', ownerCatId: 'sonnet' };
      }
      return undefined;
    };

    // blocker (request-review) + warn (writing-plans) → blocker wins
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-owner-worst',
      evalResults: [warnViolationDifferentOwner, violationWithOwner, passResult],
      resolveRuleHandoffTarget: resolver,
    });

    // blocker severity (request-review) is primary → routes to gpt52/F200
    assert.equal(packet.ownerAsk.targetFeatureId, 'F200');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'gpt52');
  });

  it('falls back to domain when violations lack owners', () => {
    const resolver = () => ({ featureId: 'F999', ownerCatId: 'should-not-appear' });
    // violationResult (from top-level) has no owner field
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-owner-no-owner',
      evalResults: [violationResult, passResult],
      resolveRuleHandoffTarget: resolver,
    });

    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
  });

  // ---- sessionContext tier (tier 2) ----

  it('routes to session author when sessionContext provided and violations have owners', () => {
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-ctx-basic',
      evalResults: [violationWithOwner, passResult],
      sessionContext: { authorCatId: 'sonnet', featureId: 'F210' },
    });

    // Tier 2: session context routes to session author
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'sonnet');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F210');
  });

  it('session context without featureId falls back to domain featureId', () => {
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-ctx-no-fid',
      evalResults: [violationWithOwner, passResult],
      sessionContext: { authorCatId: 'opus47' },
      // no featureId in sessionContext → domain's F192 used
    });

    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus47');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
  });

  it('explicit resolver takes precedence over session context', () => {
    const resolver = (owner) => {
      if (owner.skill === 'request-review') {
        return { featureId: 'F200', ownerCatId: 'gpt52' };
      }
      return undefined;
    };

    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-ctx-resolver-wins',
      evalResults: [violationWithOwner, passResult],
      resolveRuleHandoffTarget: resolver,
      sessionContext: { authorCatId: 'sonnet', featureId: 'F210' },
    });

    // Tier 1 (resolver) wins over tier 2 (sessionContext)
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'gpt52');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F200');
  });

  it('session context ignored when violations lack owners', () => {
    // violationResult has no owner field
    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-ctx-no-owner',
      evalResults: [violationResult, passResult],
      sessionContext: { authorCatId: 'sonnet', featureId: 'F210' },
    });

    // No primary owner → skip tier 2 → domain fallback
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
  });

  it('session context falls back to domain when resolver returns undefined', () => {
    const resolver = () => undefined;

    const packet = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-ctx-resolver-undef',
      evalResults: [violationWithOwner, passResult],
      resolveRuleHandoffTarget: resolver,
      // resolver returns undefined → tier 2 should kick in
      sessionContext: { authorCatId: 'opus47', featureId: 'F215' },
    });

    // Tier 1 resolver returned undefined → tier 2 sessionContext wins
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus47');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F215');
  });
});

describe('eval:sop re-eval closure (AC-E24)', () => {
  it('closure met when previously violated rules now pass', () => {
    // Build initial verdict with a violation
    const initialVerdict = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-reeval-1',
      evalResults: [violationResult, passResult],
    });

    assert.equal(initialVerdict.verdict, 'fix');

    // Re-eval: the violated rule now passes
    const resolvedResult = { ruleId: 'merge-cross-review', status: 'pass' };
    const reevalResult = reevalSopVerdict({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-reeval-2',
      evalResults: [resolvedResult, passResult, skippedResult],
      previousVerdict: initialVerdict,
    });

    assert.equal(reevalResult.closureMet, true);
    assert.deepEqual(reevalResult.resolvedRuleIds, ['merge-cross-review']);
    assert.deepEqual(reevalResult.persistingRuleIds, []);
    assert.equal(reevalResult.verdict.verdict, 'keep_observe');
  });

  it('closure NOT met when violation persists', () => {
    const initialVerdict = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-persist-1',
      evalResults: [violationResult, passResult],
    });

    // Re-eval: same violation still present
    const reevalResult = reevalSopVerdict({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-persist-2',
      evalResults: [violationResult, passResult, skippedResult],
      previousVerdict: initialVerdict,
    });

    assert.equal(reevalResult.closureMet, false);
    assert.deepEqual(reevalResult.resolvedRuleIds, []);
    assert.deepEqual(reevalResult.persistingRuleIds, ['merge-cross-review']);
    assert.equal(reevalResult.verdict.verdict, 'fix');
  });

  it('detects new violations not in previous verdict', () => {
    const initialVerdict = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-new-1',
      evalResults: [violationResult, passResult],
    });

    // New violation that wasn't in the original
    const newViolation = {
      ruleId: 'merge-redis-6399',
      status: 'violation',
      violation: {
        ruleId: 'merge-redis-6399',
        stageId: 'merge',
        kind: 'hard_rule',
        severity: 'blocker',
        predicateType: 'env_check',
        message: 'env REDIS_URL includes :6399',
        traceAnchor: 'env:REDIS_URL=redis://localhost:6399',
      },
    };

    // Original violation resolved, but new one appeared
    const resolvedOriginal = { ruleId: 'merge-cross-review', status: 'pass' };
    const reevalResult = reevalSopVerdict({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-new-2',
      evalResults: [resolvedOriginal, newViolation, passResult],
      previousVerdict: initialVerdict,
    });

    assert.equal(reevalResult.closureMet, false, 'new violation means closure not met');
    assert.deepEqual(reevalResult.resolvedRuleIds, ['merge-cross-review']);
    assert.deepEqual(reevalResult.newViolationRuleIds, ['merge-redis-6399']);
    assert.equal(reevalResult.verdict.verdict, 'fix');
  });

  it('closure met when previous verdict was keep_observe and still clean', () => {
    const cleanVerdict = buildSopVerdictHandoff({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-clean-1',
      evalResults: [passResult, skippedResult],
    });

    assert.equal(cleanVerdict.verdict, 'keep_observe');

    const reevalResult = reevalSopVerdict({
      domain: sopDomain,
      sopDefinitionId: 'development',
      sessionId: 'session-clean-2',
      evalResults: [passResult, skippedResult],
      previousVerdict: cleanVerdict,
    });

    assert.equal(reevalResult.closureMet, true);
    assert.equal(reevalResult.verdict.verdict, 'keep_observe');
  });
});

describe('AC-E21: runSopEval production orchestrator', () => {
  // Minimal SOP definition with one rule that will fire a handle_check violation
  const sopDefinition = {
    id: 'development',
    stages: [
      {
        id: 'review',
        hardRules: [
          {
            id: 'review-no-self-review',
            kind: 'hard_rule',
            text: 'reviewer must differ from author',
            severity: 'blocker',
            predicate: { type: 'handle_check', constraint: 'reviewer_not_author' },
            owner: { type: 'stage_suggested_skill', skill: 'request-review' },
          },
        ],
        pitfalls: [],
      },
    ],
  };

  // Trace where opus self-reviews → will trigger the violation
  const selfReviewTrace = {
    sessionId: 'session-prod-001',
    sopDefinitionId: 'development',
    observedStage: 'review',
    commands: [{ command: 'pnpm test' }],
    envSnapshot: { REDIS_URL: 'redis://localhost:6398' },
    gitState: { branch: 'feat/f192', ahead: 0, behind: 0, clean: true },
    handles: { author: 'opus', reviewer: 'opus' },
    shaContext: {},
  };

  // Trace where different cats → no violation
  const crossReviewTrace = {
    ...selfReviewTrace,
    sessionId: 'session-prod-002',
    handles: { author: 'opus', reviewer: 'gpt52' },
  };

  it('routes verdict to session author (trace.handles.author) when violations have rule owners', () => {
    const packet = runSopEval({
      domain: sopDomain,
      sopDefinition,
      trace: selfReviewTrace,
    });

    assert.equal(packet.verdict, 'fix');
    // AC-E21: ownerAsk routes to the session author, NOT domain infra maintainer
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
    // Without sessionContext featureId, falls back to domain's F192
    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
    // requestedAction groups by owner skill
    assert.ok(packet.ownerAsk.requestedAction.includes('request-review'));
  });

  it('produces keep_observe with domain-level routing when no violations', () => {
    const packet = runSopEval({
      domain: sopDomain,
      sopDefinition,
      trace: crossReviewTrace,
    });

    assert.equal(packet.verdict, 'keep_observe');
    // No violations → domain fallback (no sessionContext routing needed)
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
  });

  it('explicit resolver overrides trace-derived sessionContext', () => {
    const resolver = (owner) => {
      if (owner.skill === 'request-review') {
        return { featureId: 'F300', ownerCatId: 'sonnet' };
      }
      return undefined;
    };

    const packet = runSopEval({
      domain: sopDomain,
      sopDefinition,
      trace: selfReviewTrace,
      resolveRuleHandoffTarget: resolver,
    });

    assert.equal(packet.verdict, 'fix');
    // Tier 1 (resolver) wins over tier 2 (trace-derived sessionContext)
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'sonnet');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F300');
  });

  it('skips sessionContext when trace has no author handle', () => {
    const noAuthorTrace = {
      ...selfReviewTrace,
      sessionId: 'session-prod-no-author',
      handles: { reviewer: 'gpt52' },
      // no author → sessionContext should be undefined → domain fallback
    };

    const packet = runSopEval({
      domain: sopDomain,
      sopDefinition,
      trace: noAuthorTrace,
    });

    // Without author, sessionContext is not created → domain fallback
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus');
    assert.equal(packet.ownerAsk.targetFeatureId, 'F192');
  });
});
