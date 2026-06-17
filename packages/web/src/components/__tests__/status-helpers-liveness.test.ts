import { describe, expect, it } from 'vitest';
import { deriveActiveCats, statusLabel, statusTone } from '../status-helpers';

describe('statusLabel — liveness states (F118 AC-C1)', () => {
  it('returns 静默等待 for alive_but_silent', () => {
    expect(statusLabel('alive_but_silent')).toBe('静默等待');
  });

  it('returns 疑似卡住 for suspected_stall', () => {
    expect(statusLabel('suspected_stall')).toBe('疑似卡住');
  });
});

describe('statusTone — liveness states (F118 AC-C1)', () => {
  it('returns amber for alive_but_silent', () => {
    expect(statusTone('alive_but_silent')).toBe('text-amber-500');
  });

  it('returns orange for suspected_stall', () => {
    expect(statusTone('suspected_stall')).toBe('text-orange-600');
  });
});

describe('deriveActiveCats — slot-first truth source', () => {
  it('keeps legacy targetCats behavior when slot metadata is absent', () => {
    expect(deriveActiveCats({ targetCats: ['opus'], snapshotCats: ['codex'] })).toEqual(['opus', 'codex']);
  });

  it('prefers invocation slots over stale targetCats', () => {
    const active = deriveActiveCats({
      targetCats: ['codex'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'dare', mode: 'execute' },
      },
    });

    expect(active).toEqual(['dare']);
  });

  it('drops targetCats after invocation ends when no slots remain', () => {
    const active = deriveActiveCats({
      targetCats: ['codex'],
      snapshotCats: [],
      hasActiveInvocation: false,
      activeInvocations: {},
    });

    expect(active).toEqual([]);
  });

  it('keeps targetCats as degraded fallback while invocation is still active but slots are not ready', () => {
    const active = deriveActiveCats({
      targetCats: ['opus'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {},
    });

    expect(active).toEqual(['opus']);
  });

  it('returns cats from invocation slots when targetCats is empty', () => {
    const active = deriveActiveCats({
      targetCats: [],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'ideate' },
        'inv-2': { catId: 'codex', mode: 'execute' },
      },
    });

    expect(active).toEqual(['opus', 'codex']);
  });

  it('dedupes repeated cats across multiple live invocation slots', () => {
    const active = deriveActiveCats({
      targetCats: [],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'ideate' },
        'inv-2': { catId: 'opus', mode: 'execute' },
        'inv-3': { catId: 'codex', mode: 'execute' },
      },
    });

    expect(active).toEqual(['opus', 'codex']);
  });
});

describe('F194 Phase Z5 AC-Z15: ideate mode preserves targetCats union', () => {
  // co-creator alpha catch 2026-05-10 04:51："并发 at 47 和 55 但是观点采样面板只显示 47"
  // 根因：opus-47 完成后其 slot 被 markThreadInvocationComplete 清掉 →
  // deriveActiveCats 从两只猫塌成一只还在 streaming 的猫 → 47 卡片消失
  //
  // 修复：ideate mode 下 deriveActiveCats fallback 到 targetCats UNION（不只看 slots），
  // 保留本轮所有 targetCats 让卡片全程显示，slot 只决定每只猫的最终状态展示

  it('AC-Z15: ideate mode keeps both cats visible after one finishes (slot removed)', () => {
    const active = deriveActiveCats({
      targetCats: ['opus-47', 'gpt-55'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        // opus-47 已完成，slot 被 removeActiveInvocation 清掉
        'inv-2': { catId: 'gpt-55', mode: 'ideate' },
      },
      intentMode: 'ideate',
    });

    // GREEN after Z5: 两猫都在 (targetCats union, slot 状态由 callback statuses 决定)
    // RED before Z5: 只有 gpt-55，opus-47 因 slot 移除消失
    expect(active.sort()).toEqual(['gpt-55', 'opus-47']);
  });

  it('AC-Z15: ideate mode union of targetCats + slotCats + snapshotCats (no duplicates)', () => {
    const active = deriveActiveCats({
      targetCats: ['opus-47', 'gpt-55'],
      snapshotCats: ['gemini'],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'opus-47', mode: 'ideate' },
        'inv-2': { catId: 'gpt-55', mode: 'ideate' },
      },
      intentMode: 'ideate',
    });

    expect(active.sort()).toEqual(['gemini', 'gpt-55', 'opus-47']);
  });

  it('AC-Z15: execute mode (non-ideate) keeps slot-first behavior — does not regress F108', () => {
    // execute mode 下不走 ideate fallback，保留原 slot-first 语义（per F108）
    const active = deriveActiveCats({
      targetCats: ['opus-47', 'gpt-55'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        // 47 完成清 slot，但 execute mode 不开 fallback
        'inv-2': { catId: 'gpt-55', mode: 'execute' },
      },
      intentMode: 'execute',
    });

    expect(active).toEqual(['gpt-55']);
  });

  it('AC-Z15: ideate mode without intentMode param falls back to legacy slot-first behavior', () => {
    // 防呆：caller 没传 intentMode → 不开 ideate fallback (向后兼容)
    const active = deriveActiveCats({
      targetCats: ['opus-47', 'gpt-55'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-2': { catId: 'gpt-55', mode: 'ideate' },
      },
      // intentMode omitted
    });

    expect(active).toEqual(['gpt-55']);
  });
});
