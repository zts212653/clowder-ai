import type { FirstAssistantOutputEvidence, InvocationTrajectorySummary } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { buildInvocationTimelineRows, type RawTranscriptEvent } from '../invocation-trajectory-model';
import { reconcileInvocationSummary } from '../invocation-trajectory-summary';
import { firstAssistantPreview } from '../trajectory-first-output';

const identity = { provider: 'codex', runtimeSessionId: 'native-session', turnId: 'turn', nativeId: 'a' };
const source = { sessionId: 'session', invocationId: 'inv', firstEventNo: 8, lastEventNo: 9, eventCount: 2 };
const summary: InvocationTrajectorySummary = {
  sessionId: 'session',
  invocationId: 'inv',
  threadId: 'thread',
  sessionSeq: 0,
  sessionStatus: 'sealed',
  catId: 'codex61-sol',
  status: 'done',
  startedAt: 0,
  durationMs: 0,
  eventCount: 0,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 2,
  errorCount: 0,
  keyMessages: ['You，', '不可借用的后句。'],
  toolNames: [],
};
const available = (content: string): FirstAssistantOutputEvidence => ({
  role: 'assistant',
  complete: true,
  source,
  byteLength: content.length * 3,
  status: 'available',
  identity,
  channel: 'commentary',
  content,
});
const event = (
  eventNo: number,
  content: string,
  outputMessage?: Record<string, unknown>,
  extra = {},
): RawTranscriptEvent => ({
  v: 1,
  t: eventNo,
  threadId: 'thread',
  catId: 'cat',
  sessionId: 'session',
  invocationId: 'inv',
  eventNo,
  event: { type: 'text', content, ...(outputMessage ? { outputMessage } : {}), ...extra },
});
const native = (patch = {}) => ({ ...identity, channel: 'commentary', complete: false, textMode: 'append', ...patch });
const rows = (events: RawTranscriptEvent[]) =>
  buildInvocationTimelineRows(events, 100, { nativeMessages: true }).allRows;

describe('F322 proven first native output consumer', () => {
  it('does not replace newer list evidence with a stale detail snapshot', () => {
    const current = { ...summary, eventCount: 20, firstAssistantOutputEvidence: available('真实首句。') };
    const stale = {
      ...summary,
      eventCount: 10,
      firstAssistantOutputEvidence: {
        role: 'assistant' as const,
        complete: false,
        source,
        byteLength: 3,
        status: 'incomplete' as const,
      },
    };
    expect(reconcileInvocationSummary(current, stale).firstAssistantOutputEvidence).toEqual(
      current.firstAssistantOutputEvidence,
    );
    const conflict = {
      ...stale,
      eventCount: 21,
      firstAssistantOutputEvidence: { ...stale.firstAssistantOutputEvidence, status: 'conflict' as const },
    };
    expect(reconcileInvocationSummary(current, conflict).firstAssistantOutputEvidence?.status).toBe('conflict');
  });
  it('uses a complete sentence longer than the old 140-character fragment without taking the next sentence', () => {
    const sentence = `You，${'这一轮的真实首句'.repeat(25)}。`;
    expect(
      firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available(`${sentence}后一句不进入预览。`) }),
    ).toMatchObject({ kind: 'sentence', content: sentence, channel: 'commentary' });
  });
  it('preserves English decimal punctuation and trailing quotes', () => {
    expect(
      firstAssistantPreview({
        ...summary,
        firstAssistantOutputEvidence: available('The value is 3.14 today. Next sentence.'),
      }),
    ).toMatchObject({ kind: 'sentence', content: 'The value is 3.14 today.' });
    expect(
      firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available('他说：“我已查完。”后一句。') }),
    ).toMatchObject({ kind: 'sentence', content: '他说：“我已查完。”' });
  });
  it('does not promote completed You-only output, empty output, or later keyMessages into a full sentence', () => {
    for (const content of ['You，', '在']) {
      expect(firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available(content) }).kind).toBe(
        'boundary_unconfirmed',
      );
    }
    expect(firstAssistantPreview(summary).kind).toBe('unavailable');
  });
  it('keeps every unavailable status and mismatched invocation/session unavailable without body exposure', () => {
    for (const status of ['unknown_identity', 'unknown_channel', 'incomplete', 'conflict', 'oversized'] as const) {
      const evidence = { ...available('不得曝光。'), status } as FirstAssistantOutputEvidence;
      const preview = firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: evidence });
      expect(preview.kind).toBe('unavailable');
      expect(preview).not.toHaveProperty('content');
    }
    for (const mismatch of [{ invocationId: 'other' }, { sessionId: 'other' }]) {
      expect(
        firstAssistantPreview({
          ...summary,
          firstAssistantOutputEvidence: {
            ...available('错误归属。'),
            source: { ...source, ...mismatch },
          },
        }).kind,
      ).toBe('unavailable');
    }
  });
});

describe('v2 native timeline boundaries, with classic continuity', () => {
  it('merges only same message/channel and respects native append/replace across page concatenation', () => {
    const page1 = [event(8, 'You，', native())];
    const page2 = [
      event(9, '完整首句。', native()),
      event(10, '最终完整快照。', native({ textMode: 'replace', complete: true })),
    ];
    expect(rows([...page1, ...page2])).toMatchObject([
      { kind: 'message', content: '最终完整快照。', fragmentCount: 3, appendCount: 2, replaceCount: 1 },
    ]);
  });
  it('does not join different identities, channels, invocations, roles, or completed outputs', () => {
    const variants = [
      event(9, '后句。', native({ nativeId: 'b' })),
      event(9, '后句。', native({ channel: 'final' })),
      { ...event(9, '后句。', native()), invocationId: 'other' },
      event(9, '后句。', native(), { role: 'user' }),
    ];
    for (const next of variants) expect(rows([event(8, 'You，', native()), next])).toHaveLength(2);
    expect(rows([event(8, '完整首句。', native({ complete: true })), event(9, '后句。', native())])).toHaveLength(2);
    expect(buildInvocationTimelineRows([event(8, 'You，'), event(9, '后句。')]).allRows).toMatchObject([
      { content: 'You，后句。' },
    ]);
    expect(rows([event(8, 'You，'), event(9, '后句。')])).toHaveLength(2);
  });
  it('honours tool/error/turn boundaries even when tool results amend an earlier card', () => {
    for (const payload of [
      { type: 'tool_result' },
      { type: 'error', error: 'stop' },
      { type: 'done' },
      { type: 'session_init' },
    ]) {
      const events = [
        event(7, '', undefined, { type: 'tool_use', toolUseId: 't' }),
        event(8, '前文', native()),
        event(9, '', undefined, { ...payload, toolUseId: 't' }),
        event(10, '后文。', native()),
      ];
      expect(rows(events).filter((row) => row.kind === 'message')).toHaveLength(2);
    }
  });
  it('strips only verified adapter display prefix and normalises undefined exactly as JSONL does', () => {
    const events = [
      event(8, '前缀', native()),
      event(9, '\n\n完整快照。', native({ textMode: undefined, displayPrefixLength: 2, complete: true }), {
        textMode: 'replace',
      }),
    ];
    expect(rows(events)).toEqual(rows(JSON.parse(JSON.stringify(events))));
    expect(rows(events)).toMatchObject([{ content: '完整快照。' }]);
    for (const mode of [null, 'bogus', {}, false]) {
      expect(rows([event(8, '前缀', native()), event(9, '快照。', native({ textMode: mode }))])).toHaveLength(2);
    }
  });
});

describe('F322 ambiguous marker candidates remain visible', () => {
  for (const sentence of ['Use A1.', 'Run V2.', 'Choose B.', 'Found 2.', 'Fixed 3.', 'Checked 2.']) {
    it(`preserves candidate body ${sentence}`, () => {
      expect(
        firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available(`${sentence} Next sentence.`) }),
      ).toMatchObject({ kind: 'boundary_unconfirmed', content: sentence });
    });
  }
  for (const prefix of ['Step IV 2.', 'Step 2 IV.', 'Task A1 IV.', 'Phase ii 2.', 'Section 2b IV.', 'Q IV 3.']) {
    it(`labels nested structural candidate ${prefix}`, () => {
      expect(
        firstAssistantPreview({
          ...summary,
          firstAssistantOutputEvidence: available(`${prefix} Check logs. Next sentence.`),
        }).kind,
      ).toBe('boundary_unconfirmed');
    });
  }
});

describe('PR5206 R5 evidence and sentence-boundary states', () => {
  for (const candidate of [
    'Option A.',
    'Stage 1.',
    '步骤 1.',
    'Use A1.',
    'Found 2.',
    'Choose B.',
    'Iteration IV 2.',
    'ZebraLabel A1.',
    '自定义标签 IV.',
    'Dr.',
    'You，',
  ]) {
    it(`shows exact ambiguous candidate separately from its state: ${candidate}`, () => {
      const content = candidate === 'You，' ? candidate : `${candidate} Next sentence.`;
      const result = firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available(content) });
      expect(result).toEqual({
        kind: 'boundary_unconfirmed',
        content: candidate,
        label: '首句边界未确认',
        channel: 'commentary',
      });
      expect(result).not.toHaveProperty('text');
    });
  }
  it('keeps clear sentences and integrity failures distinct from boundary ambiguity', () => {
    for (const content of ['这是可核验的完整首句。', 'The first native response fully explains the observed issue.']) {
      expect(
        firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available(`${content} Later.`) }),
      ).toMatchObject({ kind: 'sentence', content });
    }
    const empty = firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available('') });
    expect(empty.kind).toBe('unavailable');
    expect(empty).not.toHaveProperty('content');
    expect(firstAssistantPreview(summary)).not.toHaveProperty('content');
  });
  it('never turns a later sentence into authority for an ambiguous first segment', () => {
    expect(
      firstAssistantPreview({ ...summary, firstAssistantOutputEvidence: available('1. Next sentence.') }),
    ).toMatchObject({ kind: 'boundary_unconfirmed', content: '1.' });
  });
});
