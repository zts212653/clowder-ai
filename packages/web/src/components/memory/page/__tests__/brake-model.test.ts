import type { StoredEventMemory } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { brakeExcerpt, groupHumanBrakes } from '../brake-model';

function event(overrides: Partial<StoredEventMemory> = {}): StoredEventMemory {
  return {
    eventId: 'e1',
    ownerUserId: 'owner',
    type: '数学之美',
    trigger: 'human_brake',
    cat: 'sonnet',
    threadId: 'thread-a',
    messageId: 'message-a',
    timestamp: 100,
    summary: '请回到原来的问题',
    cognitiveTransition: null,
    relatedHarness: null,
    confidence: 'high',
    ...overrides,
  };
}

describe('human brakes grouped by original message', () => {
  it('merges two words and two cats into one message, retaining real rule links', () => {
    const rows = groupHumanBrakes([
      event(),
      event({ eventId: 'e2', type: '第一性原理', cat: 'codex61-sol', relatedHarness: ['rule-a'] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].words).toEqual(['数学之美', '第一性原理']);
    expect(rows[0].cats).toEqual(['sonnet', 'codex61-sol']);
    expect(rows[0].rules).toEqual(['rule-a']);
  });
  it('excludes cat brakes and low-confidence word mentions', () => {
    expect(
      groupHumanBrakes([
        event(),
        event({ eventId: 'e2', messageId: 'm2', trigger: 'cat_brake' }),
        event({ eventId: 'e3', messageId: 'm3', confidence: 'low' }),
      ]),
    ).toHaveLength(1);
  });
  it('keeps different threads and unbound records separate; orders newest first', () => {
    const rows = groupHumanBrakes([
      event(),
      event({ eventId: 'e2', threadId: 'thread-b', timestamp: 200 }),
      event({ eventId: 'e3', threadId: '', messageId: '', timestamp: 300 }),
      event({ eventId: 'e4', threadId: '', messageId: '', timestamp: 400 }),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.timestamp)).toEqual([400, 300, 200, 100]);
  });
  it('deduplicates an event repeated across adjacent pages', () => {
    expect(groupHumanBrakes([event(), event()])[0].words).toEqual(['数学之美']);
  });
  it('shows the sentences around a late brake word while preserving the full stored summary', () => {
    const summary = '开场。\n背景。\n继续背景。\n前一句。\n数学之美，先回原问题。\n后一句。\n结尾。';
    expect(brakeExcerpt(summary, ['数学之美'])).toBe('…前一句。数学之美，先回原问题。后一句。…');
    expect(groupHumanBrakes([event({ summary })])[0].summary).toBe(summary);
  });
  it('does not manufacture a quote when the brake word is absent from the stored excerpt', () => {
    expect(brakeExcerpt('保存下来的短原话。', ['数学之美'])).toBe('保存下来的短原话。');
  });
  it('keeps a brake visible when one long sentence puts it below the line clamp', () => {
    const summary = `${'很长的背景'.repeat(60)}数学之美，请重新想想。`;
    const excerpt = brakeExcerpt(summary, ['数学之美']);
    expect(excerpt.indexOf('数学之美')).toBeLessThanOrEqual(49);
    expect(excerpt.startsWith('…')).toBe(true);
  });
});
