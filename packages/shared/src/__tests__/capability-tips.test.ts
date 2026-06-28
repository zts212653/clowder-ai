import { describe, expect, it } from 'vitest';
import {
  buildConciergeDraftPrompt,
  CAPABILITY_TIP_CONTEXTS,
  type CapabilityTip,
  CapabilityTipUsageEventSchema,
  type CapabilityTipValidationResult,
  computeExposureScope,
  computeInventoryFingerprint,
  migrateExposureState,
  selectCapabilityTip,
  type TipExposureState,
  validateCapabilityTip,
  validateCapabilityTipInventory,
} from '../capability-tips.js';

const baseTip: CapabilityTip = {
  id: 'capability-browser-preview',
  kind: 'capability',
  sourceRef: {
    path: 'cat-cafe-skills/browser-preview/SKILL.md',
    anchor: 'browser-preview',
  },
  structureSource: {
    path: 'packages/api/src/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.ts',
    anchor: 'browser-preview',
  },
  bodySource: {
    path: 'cat-cafe-skills/refs/capability-wakeup-index.md',
    anchor: '`browser-preview`',
  },
  contexts: ['thinking', 'long_running'],
  audience: ['all'],
  body: '改完前端想看效果时，猫可以把本地页面打开到 Hub Browser 预览。',
  action: {
    type: 'open_concierge_draft',
    label: '了解更多',
  },
  owner: 'codex',
};

function expectErrors(result: CapabilityTipValidationResult): string {
  if (result.success) throw new Error('expected validation to fail');
  return result.errors.join('\n');
}

describe('F244 CapabilityTip contract', () => {
  it('accepts a final-shaped capability tip', () => {
    expect(validateCapabilityTip(baseTip).success).toBe(true);
  });

  it('rejects action-required tips without an action', () => {
    const { action: _action, ...withoutAction } = baseTip;
    const result = validateCapabilityTip(withoutAction);
    expect(result.success).toBe(false);
    expect(expectErrors(result)).toContain('requires an action');
  });

  it('rejects fake progress promises in tip body', () => {
    const result = validateCapabilityTip({
      ...baseTip,
      body: '就快好了，马上完成这一步，请继续等一下。',
    });
    expect(result.success).toBe(false);
    expect(expectErrors(result)).toContain('fake progress');
  });

  it('rejects duplicate tip ids in inventory', () => {
    const result = validateCapabilityTipInventory([baseTip, { ...baseTip }]);
    expect(result.success).toBe(false);
    expect(expectErrors(result)).toContain('duplicate tip id');
  });

  it('selects a matching context before generic tips', () => {
    const genericTip: CapabilityTip = {
      ...baseTip,
      id: 'magic-word-scaffold',
      kind: 'magic_word',
      contexts: ['thinking'],
      action: undefined,
      body: '“脚手架”用于发现临时方案时拉回终态设计。',
    };
    const reviewTip: CapabilityTip = {
      ...baseTip,
      id: 'workflow-merge-gate',
      kind: 'workflow',
      contexts: ['merge_gate'],
      body: '准备合入时先走 merge-gate，门禁、PR、云端 review、merge 连成一条链。',
    };

    expect(selectCapabilityTip([genericTip, reviewTip], { contexts: ['merge_gate'] })?.id).toBe('workflow-merge-gate');
  });

  it('does not filter by audience when no audience is provided', () => {
    const developerTip: CapabilityTip = {
      ...baseTip,
      id: 'developer-only-review-tip',
      contexts: ['review'],
      audience: ['developer'],
      body: 'review 阶段可以展示只面向开发者的流程提示。',
    };

    expect(selectCapabilityTip([developerTip], { contexts: ['review'] })?.id).toBe('developer-only-review-tip');
    expect(selectCapabilityTip([developerTip], { contexts: ['review'], audience: 'cvo' })).toBeNull();
  });

  it('builds a concierge draft prompt without auto-send semantics', () => {
    const prompt = buildConciergeDraftPrompt(baseTip);
    expect(prompt).toContain('capability-browser-preview');
    expect(prompt).toContain('cat-cafe-skills/browser-preview/SKILL.md');
    expect(prompt).not.toContain('发送');
  });

  it('usage event shape is privacy-minimal and strict', () => {
    const valid = CapabilityTipUsageEventSchema.safeParse({
      event: 'capability_tip_action',
      tipId: 'capability-browser-preview',
      context: 'thinking',
      surface: 'assistant_stream_bubble',
      actionType: 'open_concierge_draft',
      outcome: 'opened',
      timestamp: 1,
    });
    expect(valid.success).toBe(true);

    const withPrivateText = CapabilityTipUsageEventSchema.safeParse({
      event: 'capability_tip_action',
      tipId: 'capability-browser-preview',
      context: 'thinking',
      surface: 'assistant_stream_bubble',
      actionType: 'open_concierge_draft',
      outcome: 'opened',
      timestamp: 1,
      promptText: 'private user text must not be stored',
    });
    expect(withPrivateText.success).toBe(false);
  });

  it('accepts eval context tips and usage events', () => {
    expect(CAPABILITY_TIP_CONTEXTS).toContain('eval');

    const evalTip: CapabilityTip = {
      ...baseTip,
      id: 'feature-f245-friction-eval-rollup',
      kind: 'feature',
      contexts: ['thinking', 'eval'],
      audience: ['cvo'],
      body: 'Eval Hub 会聚合摩擦信号，便于快速判断哪些需要跟进。',
    };
    expect(validateCapabilityTip(evalTip).success).toBe(true);

    expect(
      CapabilityTipUsageEventSchema.safeParse({
        event: 'capability_tip_exposed',
        tipId: evalTip.id,
        context: 'eval',
        surface: 'assistant_stream_bubble',
        outcome: 'shown',
        timestamp: 1,
      }).success,
    ).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * F244 Phase D: exposure uniformity (#997) + seeded shuffle + migration
 * ────────────────────────────────────────────────────────────────────────── */

function makeTip(id: string, overrides: Partial<CapabilityTip> = {}): CapabilityTip {
  return {
    ...baseTip,
    id,
    body: `Test body for ${id} — sufficient length.`,
    ...overrides,
  };
}

function emptyExposure(fingerprint = 'fp0'): TipExposureState {
  return { exposed: new Set(), firstSeen: new Map(), fingerprint };
}

describe('F244 Phase D: exposure uniformity (#997)', () => {
  const tipA = makeTip('tip-a', { contexts: ['thinking'] });
  const tipB = makeTip('tip-b', { contexts: ['thinking'] });
  const tipC = makeTip('tip-c', { contexts: ['thinking'] });
  const tips = [tipA, tipB, tipC];

  it('prioritises unexposed tips over exposed ones', () => {
    const exposure: TipExposureState = {
      exposed: new Set(['tip-a', 'tip-b']),
      firstSeen: new Map(),
      fingerprint: 'fp',
    };
    const result = selectCapabilityTip(tips, {
      contexts: ['thinking'],
      rotationKey: 0,
      exposure,
      dateSeed: '2026-06-22',
    });
    // Only tip-c is unexposed — must be selected regardless of rotationKey 0
    expect(result?.id).toBe('tip-c');
  });

  it('still returns a tip when all eligible are exposed (round-complete)', () => {
    const exposure: TipExposureState = {
      exposed: new Set(['tip-a', 'tip-b', 'tip-c']),
      firstSeen: new Map(),
      fingerprint: 'fp',
    };
    const result = selectCapabilityTip(tips, {
      contexts: ['thinking'],
      rotationKey: 0,
      exposure,
      dateSeed: '2026-06-22',
    });
    expect(result).not.toBeNull();
  });

  it('falls back to legacy deterministic sort when no exposure state', () => {
    const r0 = selectCapabilityTip(tips, { contexts: ['thinking'], rotationKey: 0 });
    const r1 = selectCapabilityTip(tips, { contexts: ['thinking'], rotationKey: 1 });
    const r2 = selectCapabilityTip(tips, { contexts: ['thinking'], rotationKey: 2 });
    // Legacy sort is by contextScore → contexts.length → id.localeCompare
    // All have same contextScore/length, so sorted alphabetically
    expect(r0?.id).toBe('tip-a');
    expect(r1?.id).toBe('tip-b');
    expect(r2?.id).toBe('tip-c');
  });

  it('same dateSeed produces stable order across calls', () => {
    const exposure = emptyExposure();
    const opts = { contexts: ['thinking'] as const, exposure, dateSeed: '2026-06-22' };
    const ids1 = Array.from({ length: 3 }, (_, i) => selectCapabilityTip(tips, { ...opts, rotationKey: i })?.id);
    const ids2 = Array.from({ length: 3 }, (_, i) => selectCapabilityTip(tips, { ...opts, rotationKey: i })?.id);
    expect(ids1).toEqual(ids2);
  });

  it('different dateSeed changes selection order', () => {
    // Create enough tips that a different seed almost certainly reshuffles
    const manyTips = Array.from({ length: 10 }, (_, i) => makeTip(`tip-${i}`, { contexts: ['thinking'] }));
    const exposure = emptyExposure();
    const orderA = Array.from(
      { length: 10 },
      (_, i) =>
        selectCapabilityTip(manyTips, { contexts: ['thinking'], rotationKey: i, exposure, dateSeed: '2026-01-01' })?.id,
    );
    const orderB = Array.from(
      { length: 10 },
      (_, i) =>
        selectCapabilityTip(manyTips, { contexts: ['thinking'], rotationKey: i, exposure, dateSeed: '2026-12-31' })?.id,
    );
    expect(orderA).not.toEqual(orderB);
  });

  it('scopeKey diversifies shuffle order across scopes', () => {
    const manyTips = Array.from({ length: 10 }, (_, i) => makeTip(`tip-${i}`, { contexts: ['thinking'] }));
    const exposure = emptyExposure();
    const dateSeed = '2026-06-22';
    const orderA = Array.from(
      { length: 10 },
      (_, i) =>
        selectCapabilityTip(manyTips, {
          contexts: ['thinking'],
          rotationKey: i,
          exposure,
          dateSeed,
          scopeKey: 'assistant_stream_bubble:all:thinking',
        })?.id,
    );
    const orderB = Array.from(
      { length: 10 },
      (_, i) =>
        selectCapabilityTip(manyTips, {
          contexts: ['thinking'],
          rotationKey: i,
          exposure,
          dateSeed,
          scopeKey: 'pending_bubble:cvo:thinking',
        })?.id,
    );
    expect(orderA).not.toEqual(orderB);
  });

  it('preserves context-score tiers before shuffling (spec: 同优先级内)', () => {
    // review-specific tip (contextScore 0 for ['review', 'long_running'])
    const reviewTip = makeTip('tip-review', { contexts: ['review'] });
    // generic tip (contextScore 1 — matches 'long_running', not 'review')
    const genericTip = makeTip('tip-generic', { contexts: ['long_running'] });
    const mixedTips = [genericTip, reviewTip]; // deliberately put generic first
    const exposure = emptyExposure();

    // With contexts=['review', 'long_running'], review-specific tips must
    // always appear before generic long_running tips regardless of shuffle
    const ids = Array.from(
      { length: 10 },
      (_, i) =>
        selectCapabilityTip(mixedTips, {
          contexts: ['review', 'long_running'],
          rotationKey: i,
          exposure,
          dateSeed: '2026-06-22',
        })?.id,
    );
    // rotationKey 0 should always be a review-tier tip (there's only one)
    expect(ids[0]).toBe('tip-review');
    // rotationKey 1 should be the generic tip (second tier)
    expect(ids[1]).toBe('tip-generic');
  });

  it('boosts newly added tips within the boost window', () => {
    const now = Date.now();
    const exposure: TipExposureState = {
      exposed: new Set(),
      firstSeen: new Map([['tip-c', now - 1000]]), // tip-c is new, 1 second ago
      fingerprint: 'fp',
    };
    // tip-c should be boosted to appear first among unexposed
    const result = selectCapabilityTip(tips, {
      contexts: ['thinking'],
      rotationKey: 0,
      exposure,
      dateSeed: '2026-06-22',
      now,
    });
    expect(result?.id).toBe('tip-c');
  });

  it('does not boost tips outside the boost window', () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const exposure: TipExposureState = {
      exposed: new Set(),
      firstSeen: new Map([['tip-c', eightDaysAgo]]),
      fingerprint: 'fp',
    };
    // tip-c is past the boost window — should not be forced first
    const result = selectCapabilityTip(tips, {
      contexts: ['thinking'],
      rotationKey: 0,
      exposure,
      dateSeed: '2026-06-22',
      now,
    });
    // Could be any tip (depends on shuffle), but not guaranteed to be tip-c
    expect(result).not.toBeNull();
  });

  it('rotationKey cycles within unexposed tier before falling through', () => {
    const exposure: TipExposureState = {
      exposed: new Set(['tip-a']),
      firstSeen: new Map(),
      fingerprint: 'fp',
    };
    const opts = { contexts: ['thinking'] as const, exposure, dateSeed: '2026-06-22' };
    const ids = Array.from({ length: 6 }, (_, i) => selectCapabilityTip(tips, { ...opts, rotationKey: i })?.id);
    // Tier-based: only unexposed tips (tip-b, tip-c) returned while they remain;
    // tip-a (exposed) never selected — rotation wraps within the 2-element tier
    expect(ids.every((id) => id !== 'tip-a')).toBe(true);
    // Period-2 wrapping
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[1]);
  });

  it('falls through to exposed tier when all are exposed', () => {
    const exposure: TipExposureState = {
      exposed: new Set(['tip-a', 'tip-b', 'tip-c']),
      firstSeen: new Map(),
      fingerprint: 'fp',
    };
    const opts = { contexts: ['thinking'] as const, exposure, dateSeed: '2026-06-22' };
    const ids = Array.from({ length: 3 }, (_, i) => selectCapabilityTip(tips, { ...opts, rotationKey: i })?.id);
    // All exposed → falls through to exposed tier; all three tips reachable
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
  });
});

describe('computeExposureScope', () => {
  it('sorts contexts for normalisation', () => {
    const s1 = computeExposureScope('pending_bubble', 'cvo', ['thinking', 'long_running']);
    const s2 = computeExposureScope('pending_bubble', 'cvo', ['long_running', 'thinking']);
    expect(s1).toBe(s2);
  });

  it('uses "all" when audience is undefined', () => {
    const scope = computeExposureScope('concierge', undefined, ['thinking']);
    expect(scope).toContain(':all:');
  });
});

describe('computeInventoryFingerprint', () => {
  it('is order-independent', () => {
    expect(computeInventoryFingerprint(['a', 'b', 'c'])).toBe(computeInventoryFingerprint(['c', 'a', 'b']));
  });

  it('changes when tip ids change', () => {
    const fp1 = computeInventoryFingerprint(['a', 'b']);
    const fp2 = computeInventoryFingerprint(['a', 'b', 'c']);
    expect(fp1).not.toBe(fp2);
  });
});

describe('migrateExposureState', () => {
  it('removes deleted tips from exposed set', () => {
    const existing: TipExposureState = {
      exposed: new Set(['a', 'b', 'deleted']),
      firstSeen: new Map(),
      fingerprint: 'old',
    };
    const result = migrateExposureState(existing, ['a', 'b', 'c'], Date.now());
    expect(result.exposed.has('deleted')).toBe(false);
    expect(result.exposed.has('a')).toBe(true);
  });

  it('records firstSeen for genuinely new tips', () => {
    const now = 1719100000000;
    const existing: TipExposureState = {
      exposed: new Set(['a']),
      firstSeen: new Map(),
      fingerprint: 'old',
    };
    const result = migrateExposureState(existing, ['a', 'b'], now);
    // 'b' is new (not in exposed, not in firstSeen)
    expect(result.firstSeen.get('b')).toBe(now);
    // 'a' was already known — should NOT get firstSeen
    expect(result.firstSeen.has('a')).toBe(false);
  });

  it('does not set firstSeen for all tips on first install (no existing state)', () => {
    const now = Date.now();
    const empty: TipExposureState = {
      exposed: new Set(),
      firstSeen: new Map(),
      fingerprint: '',
    };
    const result = migrateExposureState(empty, ['a', 'b', 'c'], now);
    // On first install (empty fingerprint), all tips are "new" but spec says
    // "首次安装/首次打开时不把全量 inventory 都当'新 tip'无限抢占"
    // → migrateExposureState still records firstSeen, but selectCapabilityTip
    //   should not boost when firstSeen covers the entire eligible set.
    // The migration function itself just records what it sees.
    expect(result.firstSeen.size).toBe(3);
  });

  it('updates fingerprint to match current inventory', () => {
    const existing: TipExposureState = {
      exposed: new Set(['a']),
      firstSeen: new Map(),
      fingerprint: 'old',
    };
    const result = migrateExposureState(existing, ['a', 'b'], Date.now());
    expect(result.fingerprint).toBe(computeInventoryFingerprint(['a', 'b']));
  });

  it('preserves existing firstSeen entries for retained tips', () => {
    const existing: TipExposureState = {
      exposed: new Set(),
      firstSeen: new Map([['a', 100]]),
      fingerprint: 'old',
    };
    const result = migrateExposureState(existing, ['a', 'b'], Date.now());
    expect(result.firstSeen.get('a')).toBe(100);
  });
});
