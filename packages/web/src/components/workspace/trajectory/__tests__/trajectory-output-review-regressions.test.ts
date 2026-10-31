import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { buildInvocationTimelineRows, type RawTranscriptEvent } from '../invocation-trajectory-model';
import { firstAssistantPreview } from '../trajectory-first-output';

const identity = { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'first' };
const summary: InvocationTrajectorySummary = {
  invocationId: 'inv',
  threadId: 'thread',
  sessionId: 'session',
  sessionSeq: 0,
  sessionStatus: 'sealed',
  catId: 'codex61-sol',
  status: 'done',
  startedAt: 0,
  durationMs: 0,
  eventCount: 3,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 3,
  errorCount: 0,
  toolNames: [],
  keyMessages: ['后句不能补位。'],
};
function preview(content: string) {
  return firstAssistantPreview({
    ...summary,
    firstAssistantOutputEvidence: {
      role: 'assistant',
      complete: true,
      status: 'available',
      identity,
      channel: 'commentary',
      content,
      byteLength: content.length * 3,
      source: { sessionId: 'session', invocationId: 'inv', firstEventNo: 0, lastEventNo: 2, eventCount: 3 },
    },
  });
}
const event = (eventNo: number, content: string, patch: Record<string, unknown> = {}): RawTranscriptEvent => ({
  v: 1,
  t: eventNo,
  threadId: 'thread',
  sessionId: 'session',
  catId: 'codex61-sol',
  invocationId: 'inv',
  eventNo,
  event: {
    type: 'text',
    content,
    outputMessage: { ...identity, channel: 'commentary', textMode: 'append', complete: false },
    ...patch,
  },
});
const v2 = (events: RawTranscriptEvent[]) => buildInvocationTimelineRows(events, 100, { nativeMessages: true }).allRows;

describe('PR5206 R1 first-sentence language boundaries', () => {
  it.each([
    '好。',
    '行！',
    '对。',
    '是。',
    '嗯。',
    'I did.',
    '检查了3个文件。',
    '我有1个答案。',
    '修复2处。',
    'GPT5好了。',
    '版本2可用。',
    '检查了3个文件.',
    'GPT5好了.',
  ])('preserves a complete short or numeric body sentence: %s', (first) => {
    expect(preview(`${first} Next sentence.`)).toMatchObject({ kind: 'sentence', content: first });
  });

  it('never calls punctuation/symbol-wrapped numbering or labels a complete sentence', () => {
    const symbols = Array.from({ length: 0x2800 - 0x2000 }, (_, n) => String.fromCodePoint(0x2000 + n)).filter(
      (character) => /[\p{P}\p{S}]/u.test(character),
    );
    const decorations = ['', '✅ ', '☐ ', '> ✅ ', '🧭 ', ...symbols.map((symbol) => `${symbol} `)];
    for (const decoration of decorations) {
      for (const marker of ['1.', '[1].', '1a.', 'A12b.', 'Step 1.', 'Task 1a.', 'Phase ii.']) {
        const content = `${decoration}${marker} Check logs. Next sentence.`;
        const result = preview(content);
        if (result.kind === 'sentence') expect(result.content, content).toContain('Check logs.');
      }
    }
    expect(preview('The value is 1. Next sentence.')).toMatchObject({
      kind: 'boundary_unconfirmed',
      content: 'The value is 1.',
    });
    expect(preview('✅ The value is 1. Next sentence.')).toMatchObject({
      kind: 'boundary_unconfirmed',
      content: '✅ The value is 1.',
    });
  });

  it('does not claim a bare prefix when Markdown decorations and prefix families compose', () => {
    for (const wrapper of ['', '## ', '> ## ', '## > ', '- [ ] ', '> - [ ] ', '**', '## **', '> ## **', '__']) {
      for (const marker of ['1.', 'ii.', 'Dr.', '(1).', 'Step 1.', 'Q1.']) {
        const content = `${wrapper}${marker} Check logs. Next sentence.`;
        const result = preview(content);
        if (result.kind === 'sentence') expect(result.content, content).toContain('Check logs.');
      }
    }
  });
  it('withholds body-free Markdown, parenthesised and step/question prefix segments', () => {
    for (const content of [
      '## 1. Check logs. Next sentence.',
      '### 2. 检查日志。下一句。',
      '- [ ] 1. Check logs. Next sentence.',
      '**1. Check logs.** Next sentence.',
      '(1). Check logs. Next sentence.',
      'Step 1. Check logs. Next sentence.',
      'Q1. Check logs. Next sentence.',
      '(a). Check logs. Next sentence.',
      '“Step 1.” Check logs. Next sentence.',
      '- [x] 2. Check logs. Next sentence.',
    ])
      expect(preview(content).kind, content).toBe('boundary_unconfirmed');
    expect(preview('The value is 1. Next sentence.')).toMatchObject({
      kind: 'boundary_unconfirmed',
      content: 'The value is 1.',
    });
  });
  it('does not call a bare lower-case Roman numbering segment a complete first sentence', () => {
    for (const marker of ['ii.', 'iii.', 'iv.', 'viii.', 'xvi.']) {
      expect(preview(`${marker} Check the logs. Next sentence.`).kind, marker).toBe('boundary_unconfirmed');
    }
  });
  it('does not borrow a successor segment to certify a number or honorific', () => {
    for (const prefix of ['1.', '12.', 'A.', 'III.', 'Dr.', 'Mr.', 'Prof.']) {
      expect(preview(`${prefix} Check the logs. Next sentence.`)).toMatchObject({
        kind: 'boundary_unconfirmed',
        content: prefix,
      });
    }
    expect(preview('1.2. Read the logs.')).toMatchObject({ kind: 'boundary_unconfirmed', content: '1.2.' });
  });
  it('fails closed on standalone markers/abbreviations, ambiguous abbreviation endings and paragraph breaks', () => {
    for (const text of [
      '1.',
      'Dr.',
      'Dr. Smith',
      'e.g.',
      'A.',
      'III.',
      '1. You，',
      'You，',
      'Dr.\nNext sentence.',
      '1.\nNext sentence.',
      'The files went to Acme Inc. Next sentence.',
      '“Dr.” Next sentence.',
      '“1.” Next sentence.',
      'Ph.D. Next sentence.',
      'The files went to Acme Corp. Next sentence.',
      'The files went to Acme Inc.” Next sentence.',
    ]) {
      expect(preview(text).kind, text).toBe('boundary_unconfirmed');
    }
    expect(preview('...').kind).toBe('unavailable');
  });
});

describe('PR5206 R1 explicit-role boundaries', () => {
  it('consumes illegal text roles without falling through to classic and breaks the native cursor', () => {
    for (const role of ['tool', 'ASSISTANT', ' assistant ', '', null, false, 1, {}, []]) {
      const events = [event(0, '前文'), event(1, '非法角色正文', { role }), event(2, '后文。')];
      expect(v2(events), JSON.stringify(role)).toMatchObject([{ content: '前文' }, { content: '后文。' }]);
      expect(v2(events)).toHaveLength(2);
      expect(buildInvocationTimelineRows(events).allRows).toMatchObject([{ content: '前文非法角色正文后文。' }]);
    }
  });
  it('rejects explicit roles conflicting with a typed message event and severs the cursor', () => {
    for (const [type, role] of [
      ['assistant', 'user'],
      ['user', 'assistant'],
      ['system', 'assistant'],
      ['context', 'assistant'],
    ]) {
      const events = [event(0, '前文'), event(1, '冲突角色正文', { type, role }), event(2, '后文。')];
      expect(v2(events), `${type}/${role}`).toMatchObject([{ content: '前文' }, { content: '后文。' }]);
      expect(v2(events)).toHaveLength(2);
    }
  });
  it('keeps legitimate explicit roles and canonical omission/undefined equivalent', () => {
    for (const role of ['user', 'system', 'context']) {
      expect(v2([event(0, '前文'), event(1, '合法其他角色', { role }), event(2, '后文。')])).toMatchObject([
        { role: 'assistant', content: '前文' },
        { role, content: '合法其他角色' },
        { role: 'assistant', content: '后文。' },
      ]);
    }
    const events = [event(0, '前文'), event(1, '后文。', { role: undefined })];
    expect(v2(events)).toEqual(v2(JSON.parse(JSON.stringify(events))));
    expect(v2(events)).toMatchObject([{ role: 'assistant', content: '前文后文。' }]);
  });
});
