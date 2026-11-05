import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectReplyOutput } from '../reply-output';

const content = '查前。\n\n查后。\n\n回答😺。';
const hash = createHash('sha256').update(content).digest('hex');
function fixture(): ChatMessage {
  const identity = { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'x' };
  return {
    id: 'message',
    type: 'assistant',
    catId: 'codex61-sol',
    origin: 'stream',
    timestamp: 1,
    content,
    toolEvents: [
      { id: 'use', executionRef: 'child', type: 'tool_use', label: 'read', timestamp: 1 },
      { id: 'result', executionRef: 'child', type: 'tool_result', label: 'read', timestamp: 2 },
    ],
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'child' },
      outputLayout: {
        v: 1,
        status: 'available',
        owner: { threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' },
        contentRevision: { length: content.length, sha256: hash },
        runs: [
          {
            id: 'before',
            identity: { ...identity, nativeId: 'before' },
            channel: 'commentary',
            complete: true,
            start: 0,
            end: 3,
            gluePrefixLength: 0,
          },
          {
            id: 'after',
            identity: { ...identity, nativeId: 'after' },
            channel: 'commentary',
            complete: true,
            start: 3,
            end: 8,
            gluePrefixLength: 2,
          },
          {
            id: 'answer',
            identity: { ...identity, nativeId: 'answer' },
            channel: 'final',
            complete: true,
            start: 8,
            end: content.length,
            gluePrefixLength: 2,
          },
        ],
        order: [
          { kind: 'run', runId: 'before' },
          { kind: 'tool', toolEventId: 'use', executionRef: 'child' },
          { kind: 'run', runId: 'after' },
          { kind: 'tool', toolEventId: 'result', executionRef: 'child' },
          { kind: 'run', runId: 'answer' },
        ],
      },
    },
  };
}
describe('ordinary native reply whole-body proof', () => {
  it('keeps original UTF16 coordinates and interleaves only actually moved text with real tool instances', () => {
    const projection = projectReplyOutput(fixture(), 'thread', hash);
    expect(projection?.processCount).toBe(2);
    expect(projection?.record.map((entry) => entry.id)).toEqual(['before', 'use', 'after', 'result']);
    expect(projection?.answers[0]).toMatchObject({ text: '回答😺。', start: 10, end: content.length });
  });
  for (const [label, patch] of [
    [
      'callback',
      (message: ChatMessage) => {
        message.origin = 'callback';
      },
    ],
    [
      'explicit post',
      (message: ChatMessage) => {
        if (message.extra) message.extra.isExplicitPost = true;
      },
    ],
    [
      'wrong child',
      (message: ChatMessage) => {
        if (message.extra?.stream) message.extra.stream.turnInvocationId = 'other';
      },
    ],
    [
      'missing tool',
      (message: ChatMessage) => {
        message.toolEvents = message.toolEvents?.slice(1);
      },
    ],
    [
      'other tool execution',
      (message: ChatMessage) => {
        if (message.toolEvents?.[0]) message.toolEvents[0].executionRef = 'other';
      },
    ],
    [
      'changed same-length body',
      (message: ChatMessage) => {
        message.content = message.content.replace('查', '看');
      },
    ],
    [
      'stale hash',
      (message: ChatMessage) => {
        if (message.extra?.outputLayout) message.extra.outputLayout.contentRevision.sha256 = 'a'.repeat(64);
      },
    ],
    [
      'forged glue',
      (message: ChatMessage) => {
        const layout = message.extra?.outputLayout;
        if (layout?.status === 'available') layout.runs[0].gluePrefixLength = 1;
      },
    ],
  ] as const) {
    it(`${label} preserves whole body rather than lending visibility`, () => {
      const message = fixture();
      patch(message);
      const actualHash = createHash('sha256').update(message.content).digest('hex');
      expect(projectReplyOutput(message, 'thread', actualHash)).toBeUndefined();
    });
  }
  it('unverified and wrong-thread evidence cannot move text', () => {
    expect(projectReplyOutput(fixture(), 'thread')).toBeUndefined();
    expect(projectReplyOutput(fixture(), 'other', hash)).toBeUndefined();
  });
});

describe('successful-turn tool boundary is an explicit personal display choice', () => {
  function nonNative(): ChatMessage {
    const message = fixture();
    const layout = message.extra?.outputLayout;
    if (layout?.status !== 'available') throw new Error('fixture');
    message.catId = 'opus55';
    message.extra = {
      ...message.extra,
      outputLayout: {
        v: 1,
        status: 'available',
        basis: 'successful_turn_last_tool',
        owner: { ...layout.owner, catId: 'opus55' },
        contentRevision: layout.contentRevision,
        runs: layout.runs.map(({ id, channel, start, end, gluePrefixLength }) => ({
          id,
          channel,
          start,
          end,
          gluePrefixLength,
        })),
        order: layout.order,
      },
    };
    return message;
  }
  it('defaults whole, and only an explicit record choice can move the attested earlier text', () => {
    expect(projectReplyOutput(nonNative(), 'thread', hash)).toBeUndefined();
    expect(projectReplyOutput(nonNative(), 'thread', hash, 'whole')).toBeUndefined();
    const enabled = projectReplyOutput(nonNative(), 'thread', hash, 'record');
    expect(enabled?.answers[0]?.text).toBe('回答😺。');
    expect(enabled?.processCount).toBe(2);
    expect(enabled?.showEarlierText).toBe(true);
  });
  it('an enabled preference still keeps unproven old or changed messages whole', () => {
    const old = nonNative();
    if (old.extra) delete old.extra.outputLayout;
    expect(projectReplyOutput(old, 'thread', hash, 'record')).toBeUndefined();
    const changed = nonNative();
    changed.content += ' changed';
    expect(projectReplyOutput(changed, 'thread', hash, 'record')).toBeUndefined();
  });
  it('the same preference never changes native phase selection', () => {
    expect(projectReplyOutput(fixture(), 'thread', hash, 'whole')).toEqual(
      projectReplyOutput(fixture(), 'thread', hash, 'record'),
    );
  });
});

describe('typed terminal host signature is an answer suffix', () => {
  const suffix = '\n\n[小太阳·砚砚/gpt-6.1-sol🐾]';
  function signedMessage() {
    const message = fixture();
    const start = message.content.length;
    message.content += suffix;
    const hash = createHash('sha256').update(message.content).digest('hex');
    const layout = message.extra?.outputLayout;
    if (layout?.status !== 'available') throw new Error('fixture layout');
    layout.contentRevision = { length: message.content.length, sha256: hash };
    layout.hostTail = {
      kind: 'cat_signature',
      producer: 'codex_stream_finalizer',
      basis: 'runtime_canonical',
      start,
      end: message.content.length,
      gluePrefixLength: 2,
    };
    return { message, hash, start };
  }
  it('retains canonical content and suffix coordinates without counting a process segment', () => {
    const { message, hash, start } = signedMessage();
    const result = projectReplyOutput(message, 'thread', hash);
    expect(result?.processCount).toBe(2);
    expect(result?.answers.at(-1)).toMatchObject({
      text: suffix.slice(2),
      start: start + 2,
      end: message.content.length,
    });
    expect(result?.record.map((entry) => entry.id)).toEqual(['before', 'use', 'after', 'result']);
    expect(message.content).toBe(content + suffix);
  });
  it('cannot hide changed tail bytes under a structural-only proof', () => {
    const { message } = signedMessage();
    message.content = message.content.replace('\n\n[小太阳', 'xx[小太阳');
    const hash = createHash('sha256').update(message.content).digest('hex');
    if (message.extra?.outputLayout) message.extra.outputLayout.contentRevision.sha256 = hash;
    expect(projectReplyOutput(message, 'thread', hash)).toBeUndefined();
  });
});
