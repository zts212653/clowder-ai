/**
 * F252 adapter — system_info transcript handling.
 */

import { describe, expect, it } from 'vitest';
import { adaptTranscriptEvents } from '../adapter';
import { makeEvent } from './adapter-test-helpers';

describe('F252 adapter — system_info thinking events', () => {
  it('extracts thinking from system_info with JSON { type: "thinking" } content', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({ type: 'thinking', catId: 'opus', text: 'Let me analyze...' }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'thinking',
      role: 'assistant',
      content: 'Let me analyze...',
    });
  });

  it('skips operational system_info instead of rendering raw JSON', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({ type: 'rate_limit', message: 'throttled' }),
      }),
      makeEvent(2, 1100, {
        type: 'system_info',
        content: JSON.stringify({
          type: 'mcp_server_status',
          pendingMeaning: 'deferred_tool_loading',
          servers: [{ name: 'playwright', status: 'pending' }],
        }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(0);
  });

  it('preserves visible warning system_info as formatted system replay content', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({ type: 'warning', catId: 'codex', message: 'Tool output was truncated' }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'system',
      role: 'system',
      content: '⚠️ Tool output was truncated',
    });
  });

  it('preserves visible a2a follow-up system_info as formatted system replay content', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({
          type: 'a2a_followup_available',
          mentions: [{ catId: 'codex', mentionedBy: 'opus' }],
        }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'system',
      role: 'system',
      content: 'opus @了 codex',
    });
  });

  it('preserves visible session seal system_info as formatted system replay content', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({
          type: 'session_seal_requested',
          catId: 'codex',
          sessionSeq: 3,
          healthSnapshot: { fillRatio: 0.82 },
        }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'system',
      role: 'system',
      content: 'codex 的会话 #3 已封存（上下文 82%），下次调用将自动创建新会话',
    });
  });

  it('preserves visible governance blocked system_info as formatted system replay content', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({
          type: 'governance_blocked',
          projectPath: '/workspaces/demo',
          reasonKind: 'needs_confirmation',
        }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'system',
      role: 'system',
      content: '项目 /workspaces/demo 治理状态异常',
    });
  });

  it('preserves visible silent completion system_info as formatted system replay content', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'system_info',
        content: JSON.stringify({
          type: 'silent_completion',
          detail: 'codex completed without a text response after using tools.',
        }),
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'system',
      role: 'system',
      content: 'codex completed without a text response after using tools.',
    });
  });

  it('skips system_info with non-JSON content instead of rendering internal status text', () => {
    const events = [makeEvent(1, 1000, { type: 'system_info', content: 'plain text info' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(0);
  });
});
