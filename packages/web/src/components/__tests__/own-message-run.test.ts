import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { isLastOfOwnRun, isOwnHumanMessage } from '../own-message-run';

/**
 * F322 B segment 1 (human message) — "a run of your own messages shows its time once, on the last one" (DESIGN.md「对话」).
 * A run is consecutive messages of yours that you can see; anything else that renders ends it.
 */
const own = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  type: 'user',
  content: id,
  timestamp: 1,
  ...extra,
});
const cat = (id: string): ChatMessage => ({ id, type: 'assistant', catId: 'opus', content: id, timestamp: 2 });
const system = (id: string): ChatMessage => ({ id, type: 'system', content: id, timestamp: 3 });
const recalledUnseen = (id: string): ChatMessage =>
  own(id, {
    extra: { recall: { exposure: 'none', recalledAt: 5 } } as ChatMessage['extra'],
  });

describe('isOwnHumanMessage', () => {
  it('is a user message with no cat author', () => {
    expect(isOwnHumanMessage(own('a'))).toBe(true);
    expect(isOwnHumanMessage(cat('a'))).toBe(false);
    expect(isOwnHumanMessage({ ...own('a'), catId: 'opus' })).toBe(false);
    expect(isOwnHumanMessage(system('a'))).toBe(false);
  });
});

describe('isLastOfOwnRun', () => {
  it('is the last when nothing follows it, or when it is not in the timeline we were given', () => {
    const a = own('a');
    expect(isLastOfOwnRun(a, [a])).toBe(true);
    expect(isLastOfOwnRun(a, [])).toBe(true);
    expect(isLastOfOwnRun(a, [cat('x')])).toBe(true);
  });

  it('is not the last when another message of yours follows it', () => {
    const [a, b] = [own('a'), own('b')];
    expect(isLastOfOwnRun(a, [a, b])).toBe(false);
    expect(isLastOfOwnRun(b, [a, b])).toBe(true);
  });

  it('a cat reply or a system line ends the run', () => {
    const [a, b] = [own('a'), own('b')];
    expect(isLastOfOwnRun(a, [a, cat('x'), b])).toBe(true);
    expect(isLastOfOwnRun(a, [a, system('s'), b])).toBe(true);
  });

  it('skips a message of yours that renders nothing (recalled before anyone saw it) when looking for the run', () => {
    const [a, hidden, b] = [own('a'), recalledUnseen('h'), own('b')];
    // a, [hidden], b: the hidden one is not on screen, so a and b are still one run.
    expect(isLastOfOwnRun(a, [a, hidden, b])).toBe(false);
    // a, [hidden], cat: the hidden one does not extend the run, the cat ends it.
    expect(isLastOfOwnRun(a, [a, hidden, cat('x')])).toBe(true);
    // a, [hidden] at the very end: nothing visible follows.
    expect(isLastOfOwnRun(a, [a, hidden])).toBe(true);
  });

  it('steps over rows of any kind that draw nothing: an empty finished cat message does not end the run', () => {
    const a = own('a');
    const b = own('b');
    const emptyCat: ChatMessage = { id: 'e', type: 'assistant', catId: 'opus', content: '', timestamp: 2 };

    expect(isLastOfOwnRun(a, [a, emptyCat, b])).toBe(false);
    expect(isLastOfOwnRun(b, [a, emptyCat, b])).toBe(true);
  });

  it('still ends the run on a cat row that is drawn even with no text: streaming, or only thinking', () => {
    const a = own('a');
    const b = own('b');
    const streaming: ChatMessage = {
      id: 's',
      type: 'assistant',
      catId: 'opus',
      content: '',
      timestamp: 2,
      isStreaming: true,
    };
    const thinking: ChatMessage = {
      id: 't',
      type: 'assistant',
      catId: 'opus',
      content: '',
      timestamp: 2,
      thinking: '想',
    };

    expect(isLastOfOwnRun(a, [a, streaming, b])).toBe(true);
    expect(isLastOfOwnRun(a, [a, thinking, b])).toBe(true);
  });

  it('a cross-thread source keeps an otherwise empty cat message on screen, judged against the thread it is drawn in', () => {
    const a = own('a');
    const b = own('b');
    const crossThread: ChatMessage = {
      id: 'x',
      type: 'assistant',
      catId: 'opus',
      content: '',
      timestamp: 2,
      extra: { crossPost: { sourceThreadId: 'other', sourceInvocationId: 'i' } } as ChatMessage['extra'],
    };

    expect(isLastOfOwnRun(a, [a, crossThread, b], { currentThreadId: 'here' })).toBe(true);
    // The same record read in its own source thread is not cross-thread, so it draws nothing and the run goes on.
    expect(isLastOfOwnRun(a, [a, crossThread, b], { currentThreadId: 'other' })).toBe(false);
  });

  it('the only thing it looks at is order: a later timestamp or a different id does not matter', () => {
    const a = own('a', { timestamp: 100 });
    const b = own('b', { timestamp: 1 });
    expect(isLastOfOwnRun(a, [a, b])).toBe(false);
  });
});
