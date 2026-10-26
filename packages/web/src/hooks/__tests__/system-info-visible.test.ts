import { describe, expect, it } from 'vitest';
import { formatVisibleSystemInfo } from '../system-info-visible';

describe('internal session continuity has no visible notice formatter', () => {
  it.each(['runtime_replacement', 'context_threshold'])('keeps %s outside chat', (reason) => {
    expect(
      formatVisibleSystemInfo({ type: 'session_seal_requested', catId: 'codex-sol', sessionSeq: 3, reason }),
    ).toBeNull();
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
    const visible = formatVisibleSystemInfo(payload, (c) => c);
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
    const visible = formatVisibleSystemInfo(withoutMessage, (c) => (c === 'codex' ? '缅因猫' : '暹罗猫'));
    expect(visible?.content).toContain('第 1 棒 缅因猫');
    expect(visible?.content).toContain('第 2 棒 暹罗猫');
    expect(visible?.content).toContain('cat_cafe_multi_mention');
  });
});

describe('formatVisibleSystemInfo — routing_preflight', () => {
  it('turns rejected receipts into owner-readable copy', () => {
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
      content: '宪宪：当前暂不可用。本次未执行，这条消息会等待你重试。',
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

  it('keeps warned fail-open diagnostics out of chat', () => {
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

    expect(visible).toBeNull();
  });

  it('keeps an already requested owner attempt quiet while it proceeds', () => {
    const result = formatVisibleSystemInfo(
      {
        type: 'routing_preflight',
        target: {
          targetCatId: 'codex-astra',
          disposition: 'warned',
          ownerAttempt: true,
          reasons: [{ code: 'routing_signal_unavailable', summary: 'quota_exhausted', sourceRefs: ['signal:1'] }],
          alternatives: Array.from({ length: 32 }, (_, index) => ({ catId: `alternative-${index}` })),
        },
      },
      () => 'Astra',
    );
    expect(result).toBeNull();
  });

  it('never uses recovered-history or execution-capacity diagnostics as human-facing rejection copy', () => {
    const result = formatVisibleSystemInfo(
      {
        type: 'routing_preflight',
        target: {
          targetCatId: 'codex-sol',
          disposition: 'rejected',
          reasons: [
            { code: 'routing_signal_recovered', summary: '已恢复 9 条历史状态记录', sourceRefs: ['history:1'] },
            {
              code: 'routing_capacity_unverified',
              summary: 'Execution capacity is unverified (pool applicability unknown); account observation is fresh',
              sourceRefs: ['capacity:1'],
            },
            { code: 'routing_signal_unavailable', summary: 'quota_exhausted', sourceRefs: ['quota:1'] },
          ],
        },
      },
      () => '小太阳',
    );
    expect(result).toEqual({
      content: '小太阳：近期遇到额度限制。本次未执行，这条消息会等待你重试。',
      variant: 'info',
    });
  });

  it('uses a Chinese fallback when a rejected target has only an unknown machine reason', () => {
    expect(
      formatVisibleSystemInfo({
        type: 'routing_preflight',
        target: {
          targetCatId: '小太阳',
          disposition: 'rejected',
          reasons: [{ code: 'future_provider_error', summary: 'New internal diagnostic', sourceRefs: [] }],
        },
      }),
    ).toEqual({ content: '小太阳：当前暂不可用。本次未执行，这条消息会等待你重试。', variant: 'info' });
  });
});

describe('formatVisibleSystemInfo — warning presentation', () => {
  it('keeps unclassified provider diagnostics out of chat', () => {
    expect(formatVisibleSystemInfo({ type: 'warning', message: 'model metadata missing' })).toBeNull();
  });

  it('shows actionable warnings and keeps automatic retries outside chat', () => {
    expect(
      formatVisibleSystemInfo({
        type: 'warning',
        presentation: 'user_action_required',
        message: '请重新授权',
      }),
    ).toEqual({ content: '⚠️ 请重新授权', variant: 'info' });
    expect(
      formatVisibleSystemInfo({
        type: 'warning',
        presentation: 'transient_status',
        message: '正在自动重试',
      }),
    ).toBeNull();
  });
});
