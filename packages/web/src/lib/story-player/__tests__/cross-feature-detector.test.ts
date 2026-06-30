/**
 * F252 AC-E6 — Cross-Feature Event Detection
 *
 * Detects when a replay event represents a cross-feature interaction
 * (cross_post_message to a thread NOT in the current feature).
 */
import { describe, expect, it } from 'vitest';
import { detectCrossFeatureEvent } from '../cross-feature-detector';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return {
    index: 0,
    type: 'message',
    timestamp: 1000,
    role: 'assistant',
    content: 'hello',
    eventNo: 1,
    ...overrides,
  };
}

const FEATURE_THREADS = new Set(['thread_aaa', 'thread_bbb']);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectCrossFeatureEvent', () => {
  it('returns null for plain message events', () => {
    const event = makeEvent({ type: 'message', content: 'just a message' });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('returns null for non-cross-post tool calls', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_create_task',
      toolInput: JSON.stringify({ title: 'do stuff' }),
    });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('returns null for cross_post to same-feature thread', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_aaa', content: 'hey' }),
      catId: 'opus',
    });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('detects cross_post to external thread (bare tool name)', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_xyz', content: 'cross-feature help needed' }),
      catId: 'opus',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.targetThreadId).toBe('thread_xyz');
    expect(result?.contentSnippet).toContain('cross-feature help');
    expect(result?.catId).toBe('opus');
  });

  it('detects MCP-prefixed tool name (Claude Code format)', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'mcp__cat-cafe-collab__cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_ext', content: 'ping from other feature' }),
      catId: 'codex',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.targetThreadId).toBe('thread_ext');
    expect(result?.catId).toBe('codex');
  });

  it('detects MCP-prefixed tool name (Codex format)', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'mcp:cat-cafe-collab/cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_other', content: 'collab request' }),
      catId: 'gpt52',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.targetThreadId).toBe('thread_other');
  });

  it('truncates long content to snippet', () => {
    const longContent = 'A'.repeat(200);
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_ext', content: longContent }),
      catId: 'opus',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.contentSnippet.length).toBeLessThanOrEqual(103); // 100 + '...'
  });

  it('returns null when toolInput is missing', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      catId: 'opus',
    });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('returns null when toolInput is malformed JSON', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: 'not json {{{',
      catId: 'opus',
    });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('returns null when toolInput has no threadId', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ content: 'oops no target' }),
      catId: 'opus',
    });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('returns null for system events', () => {
    const event = makeEvent({ type: 'system' });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('returns null for thinking events', () => {
    const event = makeEvent({ type: 'thinking' });
    expect(detectCrossFeatureEvent(event, FEATURE_THREADS)).toBeNull();
  });

  it('handles empty feature thread set (all cross_posts are cross-feature)', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_any', content: 'msg' }),
      catId: 'opus',
    });
    const result = detectCrossFeatureEvent(event, new Set());
    expect(result).not.toBeNull();
    expect(result?.targetThreadId).toBe('thread_any');
  });

  it('detects short MCP alias (mcp:cat-cafe/cross_post_message)', () => {
    // Cloud R4 P2: mcp:cat-cafe/cross_post_message normalizes to bare
    // "cross_post_message" (not "cat_cafe_cross_post_message"), which was
    // previously dropped by the exact-match check.
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'mcp:cat-cafe/cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_ext', content: 'short alias' }),
      catId: 'gpt52',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.targetThreadId).toBe('thread_ext');
    expect(result?.catId).toBe('gpt52');
  });

  it('detects bare cross_post_message (no prefix at all)', () => {
    const event = makeEvent({
      type: 'tool_call',
      toolName: 'cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_ext', content: 'bare name' }),
      catId: 'opus',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.targetThreadId).toBe('thread_ext');
  });

  it('preserves event index in result for seek reference', () => {
    const event = makeEvent({
      index: 42,
      type: 'tool_call',
      toolName: 'cat_cafe_cross_post_message',
      toolInput: JSON.stringify({ threadId: 'thread_ext', content: 'hey' }),
      catId: 'opus',
    });
    const result = detectCrossFeatureEvent(event, FEATURE_THREADS);
    expect(result).not.toBeNull();
    expect(result?.eventIndex).toBe(42);
  });
});
