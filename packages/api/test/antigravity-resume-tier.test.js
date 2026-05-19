import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyAntigravityResumeTier } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-resume-tier.js';

function entry(overrides = {}) {
  return {
    threadId: 'thread-1',
    catId: 'antig-opus',
    cascadeId: 'cascade-1',
    stepIndex: 1,
    stepType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    effectKind: 'side_effect_done',
    effectType: 'shell',
    operation: 'run_command',
    target: 'pnpm test',
    status: 'done',
    retrySafe: false,
    idempotencyKey: 'done:shell:run_command:abc123',
    observedAt: 1770000000000,
    ...overrides,
  };
}

function summary(entries) {
  const completedCount = entries.filter((item) => item.status === 'done').length;
  const failedCount = entries.filter((item) => item.status === 'failed').length;
  const pendingOrUnknownCount = entries.filter((item) => item.status === 'pending' || item.status === 'unknown').length;
  const hasUnsafeSideEffect = entries.some((item) => !item.retrySafe);

  return {
    entries,
    hasSideEffect: entries.length > 0,
    hasUnsafeSideEffect,
    hasCompletedSideEffect: completedCount > 0,
    hasFailedSideEffect: failedCount > 0,
    hasPendingOrUnknownSideEffect: pendingOrUnknownCount > 0,
    blocksBlindRetry: hasUnsafeSideEffect,
    dedupedEntryCount: 0,
    retrySafeSummary: {
      safeToRetry: entries.length === 0 || !hasUnsafeSideEffect,
      reason:
        entries.length === 0
          ? 'no_side_effect'
          : hasUnsafeSideEffect
            ? 'unsafe_side_effect_seen'
            : 'all_side_effects_retry_safe',
      completedCount,
      pendingOrUnknownCount,
      failedCount,
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function ownedProbe(target, overrides = {}) {
  return {
    kind: 'owned_target',
    target,
    ok: true,
    reliable: true,
    owned: true,
    ...overrides,
  };
}

describe('F201 Antigravity resume tier classifier', () => {
  test('classifies no-effect and read-only/build/test/lint work as Tier 1 auto-resumable', () => {
    assert.deepEqual(classifyAntigravityResumeTier({ journalSummary: summary([]) }), {
      tier: 'tier1_auto_readonly',
      canAutoResume: true,
      recoveryStrategy: 'auto_resume',
      reason: 'no_side_effect',
    });

    const decision = classifyAntigravityResumeTier({
      journalSummary: summary([entry({ target: 'pnpm test -- --runInBand' })]),
    });

    assert.equal(decision.tier, 'tier1_auto_readonly');
    assert.equal(decision.canAutoResume, true);
    assert.equal(decision.recoveryStrategy, 'auto_resume');
  });

  test('rejects chained build/test commands from Tier 1 auto-resume', () => {
    const decision = classifyAntigravityResumeTier({
      journalSummary: summary([entry({ target: 'pnpm test && touch /tmp/antigravity-resume-side-effect' })]),
    });

    assert.equal(decision.tier, 'tier4_manual_irreversible');
    assert.equal(decision.canAutoResume, false);
    assert.equal(decision.recoveryStrategy, 'manual_card');
  });

  test('fails closed for unknown operation and does not mutate the journal summary', () => {
    const journalSummary = summary([
      entry({
        effectType: 'unknown',
        operation: 'unknown',
        target: undefined,
        status: 'unknown',
        retrySafe: false,
      }),
    ]);
    const before = clone(journalSummary);

    const decision = classifyAntigravityResumeTier({ journalSummary });

    assert.equal(decision.tier, 'tier4_manual_irreversible');
    assert.equal(decision.canAutoResume, false);
    assert.equal(decision.recoveryStrategy, 'manual_card');
    assert.match(decision.reason, /unknown/i);
    assert.deepEqual(journalSummary, before);

    const probedUnknown = classifyAntigravityResumeTier({
      journalSummary,
      probes: [
        {
          kind: 'idempotency_key_seen',
          idempotencyKey: 'done:shell:run_command:abc123',
          ok: true,
          reliable: true,
          owned: true,
        },
      ],
    });
    assert.equal(probedUnknown.tier, 'tier4_manual_irreversible');
    assert.equal(probedUnknown.canAutoResume, false);
  });

  test('requires owned target and successful reliable probe before Tier 2 auto resume', () => {
    const ownedWorktreeSummary = summary([
      entry({
        effectType: 'code',
        operation: 'write',
        target: '/tmp/cat-cafe-antigravity-owned/sentinel.json',
        idempotencyKey: 'done:code:write:owned123',
      }),
    ]);

    const withoutProbe = classifyAntigravityResumeTier({ journalSummary: ownedWorktreeSummary });
    assert.equal(withoutProbe.tier, 'tier4_manual_irreversible');
    assert.equal(withoutProbe.canAutoResume, false);

    const unownedProbe = classifyAntigravityResumeTier({
      journalSummary: ownedWorktreeSummary,
      probes: [ownedProbe('/tmp/cat-cafe-antigravity-owned/sentinel.json', { owned: false })],
    });
    assert.equal(unownedProbe.tier, 'tier4_manual_irreversible');
    assert.equal(unownedProbe.canAutoResume, false);

    const unreliableProbe = classifyAntigravityResumeTier({
      journalSummary: ownedWorktreeSummary,
      probes: [ownedProbe('/tmp/cat-cafe-antigravity-owned/sentinel.json', { reliable: false })],
    });
    assert.equal(unreliableProbe.tier, 'tier4_manual_irreversible');
    assert.equal(unreliableProbe.canAutoResume, false);

    const provedOwned = classifyAntigravityResumeTier({
      journalSummary: ownedWorktreeSummary,
      probes: [ownedProbe('/tmp/cat-cafe-antigravity-owned/sentinel.json')],
    });
    assert.equal(provedOwned.tier, 'tier2_auto_probe_owned');
    assert.equal(provedOwned.canAutoResume, true);
    assert.equal(provedOwned.recoveryStrategy, 'auto_resume');
  });

  test('ignores Tier 1-safe entries when requiring Tier 2 probe evidence', () => {
    const ownedTarget = '/tmp/cat-cafe-antigravity-owned/sentinel.json';
    const mixedSummary = summary([
      entry({ target: 'pnpm test -- --runInBand' }),
      entry({
        effectType: 'code',
        operation: 'write',
        target: ownedTarget,
        idempotencyKey: 'done:code:write:owned123',
      }),
    ]);

    const decision = classifyAntigravityResumeTier({
      journalSummary: mixedSummary,
      probes: [ownedProbe(ownedTarget)],
    });

    assert.equal(decision.tier, 'tier2_auto_probe_owned');
    assert.equal(decision.canAutoResume, true);
    assert.equal(decision.recoveryStrategy, 'auto_resume');
  });

  test('hard-refuses root delete, Redis 6399, force push, release, and credential mutation', () => {
    const forbiddenTargets = [
      'rm -rf /',
      'redis-cli -p 6399 flushall',
      'git push --force origin main',
      'gh pr merge 1741 --squash',
      'gh release create v1.0.0',
      'cat > .env.local',
    ];

    for (const target of forbiddenTargets) {
      const decision = classifyAntigravityResumeTier({
        journalSummary: summary([entry({ target, operation: 'run_command' })]),
      });
      assert.equal(decision.tier, 'tier4_manual_irreversible', target);
      assert.equal(decision.canAutoResume, false, target);
      assert.equal(decision.recoveryStrategy, 'manual_card', target);
    }
  });

  test('hard-refuses split rm recursive force flags before Tier 2 probes', () => {
    const target = 'rm -r -f /tmp/cat-cafe-antigravity-owned';
    const decision = classifyAntigravityResumeTier({
      journalSummary: summary([entry({ target, operation: 'run_command' })]),
      probes: [ownedProbe(target)],
    });

    assert.equal(decision.tier, 'tier4_manual_irreversible');
    assert.equal(decision.canAutoResume, false);
    assert.equal(decision.recoveryStrategy, 'manual_card');
  });

  test('hard-refuses shell-wrapped rm recursive force before Tier 2 probes', () => {
    const targets = [
      'bash -lc "rm -rf /tmp/cat-cafe-antigravity-owned"',
      'bash -euo pipefail -lc "rm -r -f /tmp/cat-cafe-antigravity-owned"',
    ];
    for (const target of targets) {
      const decision = classifyAntigravityResumeTier({
        journalSummary: summary([entry({ target, operation: 'run_command' })]),
        probes: [ownedProbe(target)],
      });

      assert.equal(decision.tier, 'tier4_manual_irreversible', target);
      assert.equal(decision.canAutoResume, false, target);
      assert.equal(decision.recoveryStrategy, 'manual_card', target);
    }
  });

  test('hard-refuses force push with git global options before Tier 2 probes', () => {
    const target = 'git -C /tmp/cat-cafe-antigravity-owned push --force origin main';
    const decision = classifyAntigravityResumeTier({
      journalSummary: summary([entry({ target, operation: 'run_command' })]),
      probes: [ownedProbe(target)],
    });

    assert.equal(decision.tier, 'tier4_manual_irreversible');
    assert.equal(decision.canAutoResume, false);
    assert.equal(decision.recoveryStrategy, 'manual_card');
  });

  test('hard-refuses plus refspec force push before Tier 2 probes', () => {
    const target = 'git push origin +main';
    const decision = classifyAntigravityResumeTier({
      journalSummary: summary([entry({ target, operation: 'run_command' })]),
      probes: [ownedProbe(target)],
    });

    assert.equal(decision.tier, 'tier4_manual_irreversible');
    assert.equal(decision.canAutoResume, false);
    assert.equal(decision.recoveryStrategy, 'manual_card');
  });

  test('hard-refuses shell-wrapped force push before Tier 2 probes', () => {
    const targets = [
      'bash -lc "git push --force origin main"',
      'bash -euo pipefail -lc "git push --force origin main"',
    ];
    for (const target of targets) {
      const decision = classifyAntigravityResumeTier({
        journalSummary: summary([entry({ target, operation: 'run_command' })]),
        probes: [ownedProbe(target)],
      });

      assert.equal(decision.tier, 'tier4_manual_irreversible', target);
      assert.equal(decision.canAutoResume, false, target);
      assert.equal(decision.recoveryStrategy, 'manual_card', target);
    }
  });

  test('hard-refuses redacted sensitive targets before idempotency-key probes', () => {
    const sensitiveEntry = entry({
      effectType: 'code',
      operation: 'write',
      target: '[REDACTED_TARGET]',
      idempotencyKey: 'done:code:write:redacted-credential',
    });
    const decision = classifyAntigravityResumeTier({
      journalSummary: summary([sensitiveEntry]),
      probes: [
        {
          kind: 'idempotency_key_seen',
          idempotencyKey: 'done:code:write:redacted-credential',
          ok: true,
          reliable: true,
          owned: true,
        },
      ],
    });

    assert.equal(decision.tier, 'tier4_manual_irreversible');
    assert.equal(decision.canAutoResume, false);
    assert.equal(decision.recoveryStrategy, 'manual_card');
  });

  test('keeps shared docs, GitHub writes, and cross-thread messages in Tier 3 manual recovery', () => {
    const sharedTargets = [
      entry({
        effectType: 'code',
        operation: 'write',
        target: 'docs/features/F201-antigravity-reliability-contract.md',
      }),
      entry({ effectType: 'shell', operation: 'run_command', target: 'gh pr comment 1741 --body ready' }),
      entry({ effectType: 'mcp', operation: 'mcp_tool', target: 'cat_cafe_cross_post_message' }),
    ];

    for (const journalEntry of sharedTargets) {
      const decision = classifyAntigravityResumeTier({ journalSummary: summary([journalEntry]) });
      assert.equal(decision.tier, 'tier3_manual_shared_or_external', journalEntry.target);
      assert.equal(decision.canAutoResume, false, journalEntry.target);
      assert.equal(decision.recoveryStrategy, 'manual_card', journalEntry.target);
    }

    const probedManualTargets = [
      ['docs/features/F201-antigravity-reliability-contract.md', { effectType: 'code', operation: 'write' }],
      ['docs/lessons-learned.md', { effectType: 'code', operation: 'write' }],
      ['touch docs/features/F201-command-path.md', {}],
      ['cp /tmp/output packages/api/src/CatRouter.ts', {}],
      ['git -C /tmp/cat-cafe-antigravity-owned push origin main', {}],
      ['bash -lc "git merge main"', {}],
      ['bash -euo pipefail -lc "git merge main"', {}],
      ['git merge main', {}],
      ['git pull --rebase origin main', {}],
      ['gh pr edit 1743 --title Task4', {}],
      ['gh pr create --title Task4 --body ready', {}],
      ['/workspace/cat-cafe/packages/api/src/domains/cats/CatRouter.ts', { effectType: 'code', operation: 'write' }],
    ];

    for (const [target, overrides] of probedManualTargets) {
      const decision = classifyAntigravityResumeTier({
        journalSummary: summary([entry({ ...overrides, target })]),
        probes: [ownedProbe(target)],
      });
      assert.equal(decision.tier, 'tier3_manual_shared_or_external', target);
      assert.equal(decision.canAutoResume, false, target);
    }
  });
});
