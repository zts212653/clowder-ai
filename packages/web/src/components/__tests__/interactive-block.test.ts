/**
 * F096: InteractiveBlock — buildSelectionMessage pure function tests
 */
import { describe, expect, it } from 'vitest';
import { buildSelectionMessage } from '@/components/rich/interactive-message';

describe('F096: buildSelectionMessage', () => {
  it('select — default template (no title)', () => {
    const result = buildSelectionMessage(
      'select',
      [
        { id: 'a', label: '方案 A' },
        { id: 'b', label: '方案 B' },
      ],
      ['a'],
    );
    expect(result).toBe('我选了：方案 A');
  });

  it('select — default template with title context', () => {
    const result = buildSelectionMessage('select', [{ id: 'a', label: '方案 A' }], ['a'], undefined, '选一个方案');
    expect(result).toBe('我选了：方案 A（选一个方案）');
  });

  it('multi-select — multiple items', () => {
    const result = buildSelectionMessage(
      'multi-select',
      [
        { id: 'a', label: 'Node.js' },
        { id: 'b', label: 'pnpm' },
      ],
      ['a', 'b'],
    );
    expect(result).toBe('我选了：Node.js, pnpm');
  });

  it('card-grid — with emoji', () => {
    const result = buildSelectionMessage('card-grid', [{ id: 'a', label: '猫猫盲盒', emoji: '🎲' }], ['a']);
    expect(result).toBe('我选了：🎲 猫猫盲盒');
  });

  it('confirm — confirm action (no title)', () => {
    const result = buildSelectionMessage('confirm', [], ['__confirm__']);
    expect(result).toBe('确认');
  });

  it('confirm — cancel action (no title)', () => {
    const result = buildSelectionMessage('confirm', [], ['__cancel__']);
    expect(result).toBe('取消');
  });

  it('confirm — confirm with title context', () => {
    const result = buildSelectionMessage('confirm', [], ['__confirm__'], undefined, '确认部署到生产环境？');
    expect(result).toBe('确认 — 确认部署到生产环境？');
  });

  it('confirm — cancel with title context', () => {
    const result = buildSelectionMessage('confirm', [], ['__cancel__'], undefined, '删除分支？');
    expect(result).toBe('取消 — 删除分支？');
  });

  it('custom messageTemplate', () => {
    const result = buildSelectionMessage(
      'select',
      [{ id: 'a', label: '宪宪' }],
      ['a'],
      '我选了 {selection} 作为引导猫',
    );
    expect(result).toBe('我选了 宪宪 作为引导猫');
  });

  it('multi-select — respects selection order', () => {
    const result = buildSelectionMessage(
      'multi-select',
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      ['c', 'a'],
    );
    expect(result).toBe('我选了：C, A');
  });

  it('customInput — includes custom text in message', () => {
    const result = buildSelectionMessage(
      'select',
      [{ id: 'other', label: '我有其他想法' }],
      ['other'],
      undefined,
      undefined,
      '我觉得应该用 5 组',
    );
    expect(result).toBe('我有其他想法：我觉得应该用 5 组');
  });

  it('customInput — with title context', () => {
    const result = buildSelectionMessage(
      'select',
      [{ id: 'other', label: '其他' }],
      ['other'],
      undefined,
      'Hub 分几组',
      '六组最好',
    );
    expect(result).toBe('其他：六组最好（Hub 分几组）');
  });

  it('customInput — empty custom text falls through to default', () => {
    const result = buildSelectionMessage('select', [{ id: 'a', label: '方案 A' }], ['a'], undefined, undefined, '');
    expect(result).toBe('我选了：方案 A');
  });
});
