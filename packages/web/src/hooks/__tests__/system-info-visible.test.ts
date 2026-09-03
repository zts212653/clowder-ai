import { describe, expect, it } from 'vitest';
import { formatSessionSealRequested, formatVisibleSystemInfo } from '../system-info-visible';

describe('formatSessionSealRequested', () => {
  it('describes runtime replacement as an in-turn recovery instead of a context seal', () => {
    expect(
      formatSessionSealRequested(
        {
          type: 'session_seal_requested',
          catId: 'codex-sol',
          sessionSeq: 2,
          reason: 'cli_session_replaced',
          continuityDiagnostics: {
            source: 'runtime_replacement',
            boundary: 'runtime_replacement',
          },
        },
        () => '缅因猫 Sol',
      ),
    ).toEqual({
      content: '缅因猫 Sol 的会话 #2 已自动接力；新会话已在本轮继续运行',
      variant: 'info',
    });
  });

  it('keeps context percentage copy for a real threshold seal', () => {
    expect(
      formatSessionSealRequested(
        {
          type: 'session_seal_requested',
          catId: 'codex-sol',
          sessionSeq: 3,
          reason: 'context_threshold',
          healthSnapshot: { fillRatio: 0.82 },
        },
        () => '缅因猫 Sol',
      ),
    ).toEqual({
      content: '缅因猫 Sol 的会话 #3 已封存（上下文 82%），下次调用将自动创建新会话',
      variant: 'info',
    });
  });
});

/**
 * F086/F216 (砚砚 R1 P1): the "your N line-start @ were scheduled serially" notice must be
 * READABLE. Emitting a system_info payload with no branch here makes formatVisibleSystemInfo
 * return null, and the UI falls back to printing the raw JSON blob at the user.
 */
describe('formatVisibleSystemInfo — a2a_multi_target_serialized', () => {
  const payload = {
    type: 'a2a_multi_target_serialized',
    fromCatId: 'opus',
    mode: 'serial',
    order: ['codex', 'gemini'],
    message: '本回合有 2 个行首 @ 目标，已按 **串行（serial）** 调度：第 1 棒 缅因猫 → 第 2 棒 暹罗猫。',
  };

  it('renders readable text instead of raw JSON', () => {
    const visible = formatVisibleSystemInfo(payload, (c) => c, 'opus');
    expect(visible, 'null here means the UI prints the raw payload').not.toBeNull();
    expect(visible?.content).not.toContain('a2a_multi_target_serialized');
    expect(visible?.content).toContain('串行');
    expect(visible?.variant).toBe('info');
  });

  it('still explains the schedule when the prebuilt message is missing', () => {
    const withoutMessage = {
      type: payload.type,
      fromCatId: payload.fromCatId,
      mode: payload.mode,
      order: payload.order,
    };
    const visible = formatVisibleSystemInfo(withoutMessage, (c) => (c === 'codex' ? '缅因猫' : '暹罗猫'), 'opus');
    expect(visible?.content).toContain('第 1 棒 缅因猫');
    expect(visible?.content).toContain('第 2 棒 暹罗猫');
    expect(visible?.content).toContain('cat_cafe_multi_mention');
  });
});

describe('formatVisibleSystemInfo — routing_preflight', () => {
  it('turns warned and rejected receipts into owner-readable copy', () => {
    const visible = formatVisibleSystemInfo(
      {
        type: 'routing_preflight',
        v: 1,
        ownerId: 'owner-1',
        observedAt: 1_800_000_000_000,
        resolverState: 'fresh',
        target: {
          targetCatId: 'opus5',
          disposition: 'rejected',
          reasons: [{ code: 'routing_signal_unavailable', summary: '当前暂不可用', sourceRefs: ['signal:1'] }],
          alternatives: [{ catId: 'kimi', reasonRefs: ['catalog:1'] }],
        },
      },
      (catId) => (catId === 'opus5' ? '宪宪' : catId),
    );

    expect(visible).toEqual({
      content: '宪宪（@opus5）的发送前检查已拒绝：当前暂不可用。原目标未改派；可考虑 @kimi。',
      variant: 'info',
    });
  });

  it('keeps allowed receipts quiet', () => {
    expect(
      formatVisibleSystemInfo({
        type: 'routing_preflight',
        target: { targetCatId: 'opus5', disposition: 'allowed', reasons: [], alternatives: [] },
      }),
    ).toBeNull();
  });

  it('maps degraded routing reason codes to stable copy without exposing internal failure classes', () => {
    const visible = formatVisibleSystemInfo({
      type: 'routing_preflight',
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_800_000_000_000,
      resolverState: 'degraded',
      target: {
        targetCatId: 'codex-sol',
        disposition: 'warned',
        reasons: [
          {
            code: 'routing_context_unavailable',
            summary:
              'Routing context is degraded (resolver_degraded:built_in_profile_missing); the original target is preserved',
            sourceRefs: ['routing-context:resolver_degraded:built_in_profile_missing'],
          },
        ],
        alternatives: [],
      },
    });

    expect(visible).toEqual({
      content: 'codex-sol（@codex-sol）的发送前检查需注意：路由上下文暂时无法完整读取。原目标未改派。',
      variant: 'info',
    });
    expect(visible?.content).not.toContain('resolver_degraded');
    expect(visible?.content).not.toContain('original target');
  });
});
