import { describe, expect, it } from 'vitest';
import {
  recordThreadProgressInputSchema,
  THREAD_PROGRESS_IMPACT_AXES,
  THREAD_PROGRESS_KINDS,
} from '../types/thread-progress.js';

describe('Thread progress receipt contract', () => {
  it('accepts one bounded, human-readable terminal receipt', () => {
    const parsed = recordThreadProgressInputSchema.parse({
      kind: 'decision',
      impactAxes: ['goal_or_scope', 'next_action'],
      headline: '确定先交付单会话进度视图',
      detail: '全局近况留到 Phase B，不在本轮扩大影响面。',
      nextStep: '完成 Receipt 与 ThreadBrief 的 Phase A 验收',
      provenance: [{ kind: 'invocation', invocationId: 'inv-1' }],
    });

    expect(parsed.kind).toBe('decision');
    expect(parsed.impactAxes).toEqual(['goal_or_scope', 'next_action']);
    expect(THREAD_PROGRESS_KINDS).toContain('completed');
    expect(THREAD_PROGRESS_IMPACT_AXES).toContain('verified_outcome');
  });

  it('rejects server-owned identity and timestamp fields', () => {
    const result = recordThreadProgressInputSchema.safeParse({
      kind: 'milestone',
      impactAxes: ['verified_outcome'],
      headline: '完成存储实现',
      provenance: [{ kind: 'invocation', invocationId: 'inv-1' }],
      ownerUserId: 'forged-owner',
      threadId: 'forged-thread',
      actorCatId: 'forged-cat',
      occurredAt: 1,
      sourceKey: 'forged-key',
    });

    expect(result.success).toBe(false);
  });

  it('requires a declared recovery impact and typed provenance', () => {
    expect(
      recordThreadProgressInputSchema.safeParse({
        kind: 'milestone',
        impactAxes: [],
        headline: '只有一句状态',
        provenance: [],
      }).success,
    ).toBe(false);
    expect(
      recordThreadProgressInputSchema.safeParse({
        kind: 'milestone',
        impactAxes: ['verified_outcome'],
        headline: '完成产物',
        provenance: [{ kind: 'url', url: 'https://example.invalid' }],
      }).success,
    ).toBe(false);
  });
});
