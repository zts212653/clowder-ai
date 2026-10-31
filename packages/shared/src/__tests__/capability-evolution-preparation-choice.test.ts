import { describe, expect, it } from 'vitest';
import { evolutionPreparationItemV1Schema } from '../types/capability-evolution-preparation.js';

const ref = { ownerFeatureId: 'F117', ownerStateRef: 'message:owner-input' };
const item = {
  itemId: 'routing-policy',
  label: '陌生项目的路由策略',
  scope: '已授权的局部策略',
  why: '需要区分交接失败与策略失效',
  modifiability: { state: 'modifiable', reason: '仓内技术调整', basisRefs: [ref] },
  sourceRefs: [ref],
  nextAction: '比较同任务下的两种策略',
};
const choice = {
  category: 'Harness / 路由',
  recommendation: { summary: '优先比较', reason: '已有失败证据', basisRefs: [ref] },
  decision: {
    state: 'explore',
    reason: '在现有范围内比较',
    basisRefs: [ref],
    responsibility: { kind: 'cat', basis: 'technical' },
  },
};

describe('preparation choices preserve submitted intent without granting authority', () => {
  it('round-trips categories, recommendations and a bounded technical decision', () => {
    expect(evolutionPreparationItemV1Schema.parse({ ...item, ...choice })).toEqual({ ...item, ...choice });
  });
  it('leaves legacy items byte-for-byte unchanged without defaults', () => {
    expect(JSON.stringify(evolutionPreparationItemV1Schema.parse(item))).toBe(JSON.stringify(item));
  });
  it('requires exact human input for a human choice or existing value/budget authorization', () => {
    for (const responsibility of [{ kind: 'human' }, { kind: 'cat', basis: 'existing_authorization' }]) {
      const candidate = { ...item, ...choice, decision: { ...choice.decision, responsibility } };
      expect(evolutionPreparationItemV1Schema.safeParse(candidate).success).toBe(false);
      expect(
        evolutionPreparationItemV1Schema.safeParse({
          ...candidate,
          decision: {
            ...candidate.decision,
            responsibility: {
              ...responsibility,
              input: { threadId: 'thread-owner', messageId: 'message-owner' },
            },
          },
        }).success,
      ).toBe(true);
    }
  });
  it('keeps undecided responsibility explicit and rejects claiming exploration outside a known boundary', () => {
    expect(
      evolutionPreparationItemV1Schema.safeParse({
        ...item,
        decision: { state: 'undecided', reason: '价值取舍待输入', neededFrom: 'human' },
      }).success,
    ).toBe(true);
    for (const state of ['unknown', 'not_modifiable_this_round', 'not_applicable']) {
      expect(
        evolutionPreparationItemV1Schema.safeParse({
          ...item,
          ...choice,
          modifiability: { ...item.modifiability, state },
        }).success,
      ).toBe(false);
    }
  });
  it('rejects client supplied authors and empty decision evidence', () => {
    expect(
      evolutionPreparationItemV1Schema.safeParse({
        ...item,
        ...choice,
        decision: { ...choice.decision, authorCatId: 'operator' },
      }).success,
    ).toBe(false);
    expect(
      evolutionPreparationItemV1Schema.safeParse({
        ...item,
        ...choice,
        decision: { ...choice.decision, basisRefs: [] },
      }).success,
    ).toBe(false);
  });
});
