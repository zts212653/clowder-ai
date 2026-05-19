/**
 * F194 Phase Z11 — ChatMessage CLI Output stdout consistency (铲屎官 R15).
 *
 * After Z8 merges a stream record + a post_message callback into one
 * callback-origin bubble, ChatMessage previously fed `undefined` to
 * `toCliEvents` (gated on origin==='stream') → CLI Output lost its stdout,
 * only tools remained. Z11 projection exposes extra.stream.cliStdout +
 * speechContent so ChatMessage keeps CLI Output behavior consistent:
 *   - CLI Output ALWAYS shows the stream working log (tools + stdout)
 *   - the post_msg speech renders as the main bubble body (not the concat)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));

const { ChatMessage } = await import('../ChatMessage');

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useChatStore.getState().setUiThinkingExpandedByDefault(false);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const getCatById = () => undefined;

describe('F194 Phase Z11 — ChatMessage CLI Output stdout consistency (AC-Z29)', () => {
  it('merged callback bubble with cliStdout → CLI Output shows stream working log (not just tools)', () => {
    const msg = {
      id: 'msg-z11-merge',
      type: 'assistant' as const,
      catId: 'opus',
      // content = full concat (Z8 unchanged). Body should NOT show this whole thing.
      content: 'STREAM_WORKING_LOG_TEXT\n\nPOST_MSG_SPEECH_TEXT',
      origin: 'callback' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read x.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
      extra: {
        stream: {
          invocationId: 'parent',
          turnInvocationId: 'turn',
          cliStdout: 'STREAM_WORKING_LOG_TEXT',
          speechContent: 'POST_MSG_SPEECH_TEXT',
        },
      },
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const text = container.textContent ?? '';
    // CLI Output block present + carries the stream working log (consistency fix)
    expect(text).toContain('CLI Output');
    expect(text).toContain('STREAM_WORKING_LOG_TEXT');
    // post_msg speech shown as main body
    expect(text).toContain('POST_MSG_SPEECH_TEXT');
  });

  it('merged bubble: main body renders only the speech, NOT the duplicated stream log', () => {
    const msg = {
      id: 'msg-z11-nodup',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'DUP_STREAM_LOG\n\nTHE_SPEECH',
      origin: 'callback' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'bash', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
      extra: {
        stream: {
          invocationId: 'p',
          turnInvocationId: 't',
          cliStdout: 'DUP_STREAM_LOG',
          speechContent: 'THE_SPEECH',
        },
      },
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    // DUP_STREAM_LOG must appear exactly once (in CLI Output), not twice
    // (would be twice if main body rendered the full concat).
    const occurrences = (container.textContent ?? '').split('DUP_STREAM_LOG').length - 1;
    expect(occurrences).toBe(1);
  });

  it('pure stream (no merge) unchanged — CLI Output still shows stdout', () => {
    const msg = {
      id: 'msg-z11-pure-stream',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'PURE_STREAM_STDOUT',
      origin: 'stream' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read y.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('CLI Output');
    expect(text).toContain('PURE_STREAM_STDOUT');
  });
});
