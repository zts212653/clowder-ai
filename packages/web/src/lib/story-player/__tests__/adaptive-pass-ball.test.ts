/**
 * F252 Phase B — Pass-Ball Detection + Combined Annotation Tests (AC-B1)
 *
 * Tests for pass-ball event detection (行首 @mention, collaboration tool calls)
 * and combined idle + pass-ball annotation on the same event.
 *
 * Split from adaptive-pacing.test.ts to stay under 350-line hard limit.
 */

import { describe, expect, it } from 'vitest';
import { annotateAdaptivePacing, isPassBallEvent } from '../adaptive-pacing';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ReplayEvent> & { timestamp: number }): ReplayEvent {
  return {
    index: 0,
    type: 'message',
    role: 'assistant',
    content: '',
    eventNo: 0,
    ...overrides,
  };
}

const TEN_MIN = 10 * 60 * 1000;

// ==========================================================================
// § 1  Pass-ball event detection
// ==========================================================================

describe('F252 adaptive pacing — pass-ball detection', () => {
  it('detects @mention at line start in message content', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'message',
      role: 'assistant',
      content: '@codex\n请帮忙 review 一下这个 PR',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects @mention after markdown list prefix', () => {
    const event = makeEvent({ timestamp: 1000, type: 'message', content: '- @gpt52 请 review' });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects @mention after blockquote prefix', () => {
    const event = makeEvent({ timestamp: 1000, type: 'message', content: '> @opus47 这里需要确认' });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects cross_post tool calls', () => {
    const event = makeEvent({ timestamp: 1000, type: 'tool_call', toolName: 'cat_cafe_cross_post_message' });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects MCP-prefixed collaboration tool calls (Codex event format)', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'mcp:cat-cafe-collab/cat_cafe_cross_post_message',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects Claude Code MCP-prefixed tool calls (mcp__ format)', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'mcp__cat-cafe-collab__cat_cafe_cross_post_message',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects post_message with mentions in content', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'cat_cafe_post_message',
      content: '@sonnet 请帮忙测试',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects post_message pass-ball from toolInput when content is empty', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'cat_cafe_post_message',
      content: '',
      toolInput: JSON.stringify({ content: '@codex 请 review', threadId: 'thread_123' }),
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects post_message pass-ball from targetCats in toolInput', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'cat_cafe_post_message',
      content: '',
      toolInput: JSON.stringify({ content: 'Here is the analysis', targetCats: ['codex'] }),
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('does NOT flag post_message without @mention or targetCats', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'cat_cafe_post_message',
      content: '',
      toolInput: JSON.stringify({ content: 'Just a status update', threadId: 'thread_123' }),
    });
    expect(isPassBallEvent(event)).toBe(false);
  });

  it('detects multi_mention tool calls', () => {
    const event = makeEvent({ timestamp: 1000, type: 'tool_call', toolName: 'cat_cafe_multi_mention' });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects @mention with punctuation-ending handle (e.g. @co-creator)', () => {
    const event = makeEvent({ timestamp: 1000, type: 'message', content: '@co-creator 请看一下这个' });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('does NOT flag @mention mid-sentence (not at line start)', () => {
    const event = makeEvent({ timestamp: 1000, type: 'message', content: '我觉得应该问 @codex 看看' });
    expect(isPassBallEvent(event)).toBe(false);
  });

  it('does NOT flag @mention in URLs', () => {
    const event = makeEvent({ timestamp: 1000, type: 'message', content: 'See https://github.com/@someone/repo' });
    expect(isPassBallEvent(event)).toBe(false);
  });

  it('does NOT flag tool_result events', () => {
    const event = makeEvent({ timestamp: 1000, type: 'system', content: '@codex result here' });
    expect(isPassBallEvent(event)).toBe(false);
  });

  it('detects short MCP alias cross_post (mcp:cat-cafe/cross_post_message)', () => {
    // Cloud R4 audit: mcp:cat-cafe/cross_post_message normalizes to bare
    // "cross_post_message", must still be recognized as pass-ball.
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'mcp:cat-cafe/cross_post_message',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects bare cross_post_message (no prefix)', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'cross_post_message',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('detects bare multi_mention (no prefix)', () => {
    const event = makeEvent({
      timestamp: 1000,
      type: 'tool_call',
      toolName: 'multi_mention',
    });
    expect(isPassBallEvent(event)).toBe(true);
  });

  it('does NOT flag regular tool calls (non-collaboration)', () => {
    const event = makeEvent({ timestamp: 1000, type: 'tool_call', toolName: 'Read' });
    expect(isPassBallEvent(event)).toBe(false);
  });

  it('annotateAdaptivePacing sets isPassBall on matching events', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, eventNo: 0, content: 'hello' }),
      makeEvent({ index: 1, timestamp: 2000, eventNo: 1, content: '@codex\n请 review' }),
      makeEvent({ index: 2, timestamp: 3000, eventNo: 2, content: 'ok' }),
    ];
    const result = annotateAdaptivePacing(events);

    expect(result[0].isPassBall).toBeFalsy();
    expect(result[1].isPassBall).toBe(true);
    expect(result[2].isPassBall).toBeFalsy();
  });
});

// ==========================================================================
// § 2  Combined annotation (idle + pass-ball together)
// ==========================================================================

describe('F252 adaptive pacing — combined annotation', () => {
  it('annotates both idleSkipMs and isPassBall on same event', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, eventNo: 0, content: 'done' }),
      makeEvent({
        index: 1,
        timestamp: 1000 + TEN_MIN,
        eventNo: 1,
        content: '@codex\n请 review 这个 PR',
      }),
    ];
    const result = annotateAdaptivePacing(events);

    expect(result[1].idleSkipMs).toBe(TEN_MIN);
    expect(result[1].isPassBall).toBe(true);
  });

  it('preserves existing event fields unchanged', () => {
    const events = [
      makeEvent({
        index: 0,
        timestamp: 1000,
        eventNo: 42,
        content: 'test content',
        role: 'user',
        invocationId: 'inv-123',
        catId: 'opus',
      }),
    ];
    const result = annotateAdaptivePacing(events);

    expect(result[0].eventNo).toBe(42);
    expect(result[0].content).toBe('test content');
    expect(result[0].role).toBe('user');
    expect(result[0].invocationId).toBe('inv-123');
    expect(result[0].catId).toBe('opus');
  });
});
