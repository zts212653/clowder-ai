/**
 * F096 Phase C: InteractiveBlockGroup — buildGroupMessage + groupBlocks tests
 */
import { describe, expect, it } from 'vitest';
import { buildSelectionMessage } from '@/components/rich/InteractiveBlock';
import { buildGroupMessage } from '@/components/rich/InteractiveBlockGroup';
import type { RichInteractiveBlock } from '@/stores/chat-types';

const selectBlock: RichInteractiveBlock = {
  id: 'b1',
  kind: 'interactive',
  v: 1,
  interactiveType: 'select',
  title: '今晚吃什么？',
  options: [
    { id: 'hotpot', label: '火锅', emoji: '🍲' },
    { id: 'sushi', label: '寿司', emoji: '🍣' },
  ],
  groupId: 'g1',
};

const multiBlock: RichInteractiveBlock = {
  id: 'b2',
  kind: 'interactive',
  v: 1,
  interactiveType: 'multi-select',
  title: '加强什么？',
  options: [
    { id: 'mem', label: '记忆力', emoji: '🧠' },
    { id: 'auto', label: '自主性', emoji: '🚀' },
  ],
  groupId: 'g1',
};

const confirmBlock: RichInteractiveBlock = {
  id: 'b3',
  kind: 'interactive',
  v: 1,
  interactiveType: 'confirm',
  title: '加鸡腿？',
  options: [
    { id: '__confirm__', label: '加！' },
    { id: '__cancel__', label: '不加' },
  ],
  groupId: 'g1',
};

describe('F096 Phase C: buildGroupMessage', () => {
  it('combines all block selections into one message', () => {
    const selections = new Map([
      ['b1', ['hotpot']],
      ['b2', ['mem', 'auto']],
      ['b3', ['__confirm__']],
    ]);
    const msg = buildGroupMessage([selectBlock, multiBlock, confirmBlock], selections);
    expect(msg).toContain('🍲 火锅');
    expect(msg).toContain('🧠 记忆力');
    expect(msg).toContain('🚀 自主性');
    expect(msg).toContain('确认 — 加鸡腿？');
    // Each block on its own line
    const lines = msg.split('\n');
    expect(lines.length).toBe(3);
  });

  it('skips blocks with no selection', () => {
    const selections = new Map([['b1', ['sushi']]]);
    const msg = buildGroupMessage([selectBlock, multiBlock], selections);
    expect(msg).toContain('🍣 寿司');
    expect(msg).not.toContain('记忆力');
  });

  it('returns empty string when no selections', () => {
    const msg = buildGroupMessage([selectBlock], new Map());
    expect(msg).toBe('');
  });

  it('uses messageTemplate per block', () => {
    const customBlock: RichInteractiveBlock = {
      ...selectBlock,
      id: 'b4',
      messageTemplate: '晚饭吃 {selection}！',
    };
    const selections = new Map([['b4', ['hotpot']]]);
    const msg = buildGroupMessage([customBlock], selections);
    expect(msg).toBe('晚饭吃 🍲 火锅！');
  });
});

describe('F096: buildGroupMessage with customTexts', () => {
  const selectWithCustom: RichInteractiveBlock = {
    id: 'b5',
    kind: 'interactive',
    v: 1,
    interactiveType: 'select',
    title: '其他想法？',
    options: [
      { id: 'a', label: '方案 A' },
      { id: 'other', label: '我有其他想法', customInput: true },
    ],
  };

  it('P1-2: includes customText in group message when provided', () => {
    const selections = new Map([['b5', ['other']]]);
    const customTexts = new Map([['b5', '用 5 组']]);
    const msg = buildGroupMessage([selectWithCustom], selections, customTexts);
    expect(msg).toContain('用 5 组');
  });

  it('P1-2: works without customTexts param (backward compat)', () => {
    const selections = new Map([['b5', ['a']]]);
    const msg = buildGroupMessage([selectWithCustom], selections);
    expect(msg).toContain('方案 A');
  });
});

describe('F096 Phase C: buildSelectionMessage title context', () => {
  it('select with title adds parenthetical', () => {
    const msg = buildSelectionMessage('select', [{ id: 'a', label: 'A' }], ['a'], undefined, '问题一');
    expect(msg).toBe('我选了：A（问题一）');
  });

  it('confirm with title adds dash separator', () => {
    const msg = buildSelectionMessage('confirm', [], ['__cancel__'], undefined, '删库？');
    expect(msg).toBe('取消 — 删库？');
  });
});
