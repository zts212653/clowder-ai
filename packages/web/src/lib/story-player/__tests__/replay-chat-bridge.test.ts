import { describe, expect, it } from 'vitest';
import { bridgeReplayEvent } from '../replay-chat-bridge';
import type { ReplayEvent } from '../types';

function makeEvent(overrides: Partial<ReplayEvent> & { type: ReplayEvent['type'] }): ReplayEvent {
  return {
    index: 0,
    timestamp: 1000,
    role: 'assistant',
    content: '',
    eventNo: 0,
    ...overrides, // type comes from overrides (required by signature)
  };
}

function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('bridgeReplayEvent', () => {
  describe('message events', () => {
    it('maps assistant message to type=assistant with catId', () => {
      const event = makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'Hello!',
        catId: 'opus',
        index: 3,
        timestamp: 5000,
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('assistant');
      expect(result.content).toBe('Hello!');
      expect(result.catId).toBe('opus');
      expect(result.id).toBe('replay_3');
      expect(result.timestamp).toBe(5000);
      expect(result.isStreaming).toBe(false);
    });

    it('maps user message to type=user without catId', () => {
      const event = makeEvent({
        type: 'message',
        role: 'user',
        content: 'What is this?',
        index: 1,
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('user');
      expect(result.content).toBe('What is this?');
      expect(result.catId).toBeUndefined();
    });

    it('maps system role to type=system', () => {
      const event = makeEvent({
        type: 'message',
        role: 'system',
        content: 'Context loaded',
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('system');
    });

    it('falls back to system for unknown roles', () => {
      const event = makeEvent({
        type: 'message',
        role: 'unknown_role',
        content: 'Something',
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('system');
    });
  });

  describe('tool_call events', () => {
    it('maps tool_call to assistant with toolEvents', () => {
      const event = makeEvent({
        type: 'tool_call',
        index: 2,
        catId: 'opus',
        toolName: 'Read',
        toolInput: '{"path":"/a.ts"}',
        toolResult: 'file content here',
        toolIsError: false,
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('assistant');
      expect(result.content).toBe('');
      expect(result.toolEvents).toHaveLength(1);
      expect(defined(result.toolEvents?.[0])).toEqual({
        id: 'tool_2',
        name: 'Read',
        input: '{"path":"/a.ts"}',
        output: 'file content here',
        isError: false,
        status: 'completed',
      });
    });

    it('maps errored tool_call with status=error', () => {
      const event = makeEvent({
        type: 'tool_call',
        index: 5,
        toolName: 'Bash',
        toolResult: 'command not found',
        toolIsError: true,
      });
      const result = bridgeReplayEvent(event);
      const toolEvent = defined(result.toolEvents?.[0]);
      expect(toolEvent.status).toBe('error');
      expect(toolEvent.isError).toBe(true);
    });

    it('handles tool_call without toolName gracefully', () => {
      const event = makeEvent({
        type: 'tool_call',
        index: 6,
      });
      const result = bridgeReplayEvent(event);
      expect(defined(result.toolEvents?.[0]).name).toBe('unknown');
    });

    it('handles tool_call without result', () => {
      const event = makeEvent({
        type: 'tool_call',
        index: 7,
        toolName: 'Bash',
        // no toolResult or toolIsError
      });
      const result = bridgeReplayEvent(event);
      const toolEvent = defined(result.toolEvents?.[0]);
      expect(toolEvent.output).toBeUndefined();
      expect(toolEvent.isError).toBeUndefined();
      expect(toolEvent.status).toBe('completed');
    });
  });

  describe('thinking events', () => {
    it('maps thinking to assistant with thinking field and empty content', () => {
      const event = makeEvent({
        type: 'thinking',
        content: 'Let me analyze this...',
        catId: 'opus',
        index: 4,
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('assistant');
      expect(result.thinking).toBe('Let me analyze this...');
      expect(result.content).toBe('');
      expect(result.catId).toBe('opus');
    });
  });

  describe('system events', () => {
    it('maps system event to type=system', () => {
      const event = makeEvent({
        type: 'system',
        role: 'system',
        content: 'Session started',
        index: 0,
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('system');
      expect(result.content).toBe('Session started');
    });

    it('maps system event with empty content', () => {
      const event = makeEvent({
        type: 'system',
        role: 'system',
        content: '',
      });
      const result = bridgeReplayEvent(event);
      expect(result.type).toBe('system');
      expect(result.content).toBe('');
    });
  });

  it('produces identical output for identical input (INV-6)', () => {
    const event = makeEvent({
      type: 'message',
      role: 'assistant',
      content: 'Deterministic',
      index: 42,
      catId: 'opus',
    });
    const a = bridgeReplayEvent(event);
    const b = bridgeReplayEvent(event);
    expect(a).toEqual(b);
  });

  it('handles all ReplayEvent types without throwing (INV-7)', () => {
    const types: ReplayEvent['type'][] = ['message', 'tool_call', 'system', 'thinking'];
    for (const t of types) {
      expect(() => bridgeReplayEvent(makeEvent({ type: t, content: 'test' }))).not.toThrow();
    }
  });

  it('preserves invocationId when present', () => {
    const event = makeEvent({
      type: 'message',
      role: 'assistant',
      content: 'Hi',
      invocationId: 'inv_123',
    });
    const result = bridgeReplayEvent(event);
    expect(result.invocationId).toBe('inv_123');
  });
});
