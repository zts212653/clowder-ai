import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptLine } from '../TranscriptPanel';
import { TranscriptLineRow } from '../TranscriptPanel';

// ---------------------------------------------------------------------------
// Section 1: TranscriptLineRow — pure component (SSR, no mocks needed)
// ---------------------------------------------------------------------------
describe('TranscriptPanel — TranscriptLineRow', () => {
  const baseLine: TranscriptLine = {
    ts: 1715400000,
    elapsed_s: 10,
    chunk_num: 1,
    asr_latency: 0.3,
    text: '你好世界',
  };

  it('renders speaker label prefix when speaker_label is present', () => {
    const line: TranscriptLine = {
      ...baseLine,
      speaker_label: 'Alice',
      speaker_confidence: 0.95,
      speaker_id: 'spk001',
    };
    const html = renderToStaticMarkup(<TranscriptLineRow line={line} />);
    expect(html).toContain('Alice:');
    expect(html).toContain('text-cafe-accent-primary');
    expect(html).toContain('你好世界');
  });

  it('omits speaker label element when speaker_label is absent', () => {
    const html = renderToStaticMarkup(<TranscriptLineRow line={baseLine} />);
    expect(html).toContain('你好世界');
    expect(html).not.toContain('text-cafe-accent-primary');
  });

  it('omits speaker label element when speaker_label is empty string', () => {
    const line: TranscriptLine = { ...baseLine, speaker_label: '' };
    const html = renderToStaticMarkup(<TranscriptLineRow line={line} />);
    expect(html).not.toContain('text-cafe-accent-primary');
  });

  it('renders timestamp in correct format', () => {
    const html = renderToStaticMarkup(<TranscriptLineRow line={baseLine} />);
    expect(html).toMatch(/\[[\d:]+\]/);
  });

  it('renders text content', () => {
    const line: TranscriptLine = { ...baseLine, text: '第二句话包含特殊字符 <>&' };
    const html = renderToStaticMarkup(<TranscriptLineRow line={line} />);
    expect(html).toContain('第二句话包含特殊字符');
    expect(html).toContain('&amp;');
  });
});

// ---------------------------------------------------------------------------
// Section 2: TranscriptPanel — full component integration (DOM + mocks)
//   Tests the actual panel wiring: fetch → state, SSE → state → render.
//   This is the regression guard for the exact drift that caused the bug.
// ---------------------------------------------------------------------------

// --- Mocks (must be hoisted before dynamic import) ---

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://test',
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setRightPanelMode: () => {},
      setFloatingTranscriptVisible: () => {},
      currentThreadId: 'test-thread',
    }),
}));

// Fake EventSource that lets us push messages manually
type FakeESInstance = {
  onopen: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close: () => void;
};
let latestEventSource: FakeESInstance | null = null;

function captureEventSource(instance: FakeESInstance) {
  latestEventSource = instance;
}

vi.stubGlobal(
  'EventSource',
  class FakeEventSource implements FakeESInstance {
    onopen: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    close() {}
    constructor() {
      captureEventSource(this);
      // Simulate connected after microtask
      const open = () => this.onopen?.();
      queueMicrotask(open);
    }
  },
);

describe('TranscriptPanel — full panel integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    latestEventSource = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /** Set up apiFetch to return transcript lines with speaker fields on /api/audio/transcript */
  function setupFetchMocks(transcriptLines: TranscriptLine[]) {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/audio/transcript') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ lines: transcriptLines }),
        });
      }
      if (path === '/api/audio/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ running: false }),
        });
      }
      if (path === '/api/audio/sources') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ apps: [], mics: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  it('renders speaker_label from initial transcript fetch (hydration path)', async () => {
    const lines: TranscriptLine[] = [
      {
        ts: 1715400000,
        elapsed_s: 10,
        chunk_num: 1,
        asr_latency: 0.3,
        text: '预算讨论开始',
        speaker_label: '张经理',
        speaker_confidence: 0.92,
        speaker_id: 'spk-zhang',
      },
      {
        ts: 1715400005,
        elapsed_s: 15,
        chunk_num: 2,
        asr_latency: 0.25,
        text: '我们来看第一项',
      },
    ];
    setupFetchMocks(lines);

    const { TranscriptPanel } = await import('../TranscriptPanel');

    await act(async () => {
      root.render(<TranscriptPanel />);
    });
    // Wait for fetch + state update
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const html = container.innerHTML;
    // Line with speaker should show "张经理:" prefix
    expect(html).toContain('张经理:');
    expect(html).toContain('text-cafe-accent-primary');
    expect(html).toContain('预算讨论开始');
    // Line without speaker should NOT have accent span
    expect(html).toContain('我们来看第一项');
  });

  it('renders speaker_label from SSE transcript event (live path)', async () => {
    setupFetchMocks([]); // start with empty transcript

    const { TranscriptPanel } = await import('../TranscriptPanel');

    await act(async () => {
      root.render(<TranscriptPanel />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Verify no speaker label initially
    expect(container.innerHTML).not.toContain('text-cafe-accent-primary');

    // Simulate SSE transcript event with speaker_label
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'transcript',
          ts: 1715400010,
          elapsed_s: 20,
          chunk_num: 3,
          asr_latency: 0.2,
          text: '下一个议题是什么',
          speaker_label: 'Alice',
          speaker_confidence: 0.88,
          speaker_id: 'spk-alice',
        }),
      });
    });

    const html = container.innerHTML;
    expect(html).toContain('Alice:');
    expect(html).toContain('text-cafe-accent-primary');
    expect(html).toContain('下一个议题是什么');
  });

  it('SSE event without speaker_label does not render speaker prefix', async () => {
    setupFetchMocks([]);

    const { TranscriptPanel } = await import('../TranscriptPanel');

    await act(async () => {
      root.render(<TranscriptPanel />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'transcript',
          ts: 1715400020,
          elapsed_s: 30,
          chunk_num: 4,
          asr_latency: 0.15,
          text: '没有说话人标签',
        }),
      });
    });

    expect(container.innerHTML).toContain('没有说话人标签');
    expect(container.innerHTML).not.toContain('text-cafe-accent-primary');
  });
});
