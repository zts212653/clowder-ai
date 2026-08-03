import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => undefined }),
}));

const longInvocationId = 'invocation-f269-session-audit-overflow-recovery-with-a-preserved-tail';
const longRuntimeSessionId = 'cascade-f269-session-audit-overflow-recovery-with-a-preserved-tail';
const longConversationId = 'conversation-f269-session-audit-overflow-recovery-with-a-preserved-tail';
const chatPayload = {
  messages: [{ role: 'user', content: 'hello', timestamp: 1000 }],
  nextCursor: null,
  total: 1,
};
const handoffPayload = {
  invocations: [
    {
      invocationId: 'inv-1',
      eventCount: 5,
      toolCalls: ['Read'],
      errors: 0,
      durationMs: 1200,
      keyMessages: [],
    },
  ],
  nextCursor: null,
  total: 1,
};

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonOk(data: unknown): Promise<MockResponse> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

function notFound(): Promise<MockResponse> {
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

function setInlineOverflow(element: Element) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 80 },
    scrollWidth: { configurable: true, value: 800 },
  });
}

async function measureInlineOverflow(...elements: Element[]) {
  for (const element of elements) setInlineOverflow(element);
  await act(async () => window.dispatchEvent(new Event('resize')));
}

function measuredValue(container: ParentNode, value: string) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-measure="inline"]')).find(
    (element) => element.textContent === value,
  );
}

describe('SessionEventsViewer F269 recovery contracts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderViewer() {
    const { SessionEventsViewer } = await import('../SessionEventsViewer');
    await act(async () => root.render(<SessionEventsViewer sessionId="s1" onClose={vi.fn()} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }

  async function switchView(label: 'Handoff' | 'Raw') {
    const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    await act(async () => button?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }

  it('recovers every external runtime metadata value only after measured overflow', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/sessions/s1/events')) return jsonOk(chatPayload);
      if (url === '/api/external-runtime-sessions/s1') {
        return jsonOk({
          sessionId: 's1',
          threadId: 'external-runtime:antigravity-desktop:user-1',
          runtime: 'antigravity-desktop',
          runtimeSessionId: longRuntimeSessionId,
          runtimeConversationId: longConversationId,
          catId: 'antigravity',
          model: 'gemini-3.1-pro-with-a-long-diagnostic-suffix',
          lastObservedAt: 1000,
          lifecycle: { state: 'active', startedAt: 900, lastObservedAt: 1000 },
          binding: { mode: 'thread', threadId: 'thread-1', requestedBy: 'agent_key' },
          identityHistory: [],
          drilldown: {
            sessionRecord: '/api/sessions/s1',
            events: '/api/sessions/s1/events',
            digest: '/api/sessions/s1/digest',
          },
        });
      }
      if (url === '/api/sessions/s1/digest') return jsonOk({ diagnostics: { noise: [] } });
      return notFound();
    });

    await renderViewer();

    const measured = Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-measure="inline"]'));
    expect(measured).toHaveLength(4);
    expect(measuredValue(container, longRuntimeSessionId)).toBeTruthy();
    expect(measuredValue(container, longConversationId)).toBeTruthy();
    expect(container.querySelector('button[aria-label^="复制完整"]')).toBeNull();

    await measureInlineOverflow(...measured);

    expect(container.querySelector('button[aria-label="复制完整Cascade ID"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="复制完整Conversation ID"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="复制完整运行身份"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="复制完整绑定方式"]')).toBeTruthy();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="复制完整Cascade ID"]')?.click(),
    );
    expect(writeText).toHaveBeenCalledWith(longRuntimeSessionId);
  });

  it('recovers the full handoff invocation ID without relying on a native hover title', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.includes('view=handoff')) {
        return jsonOk({
          invocations: [
            {
              invocationId: longInvocationId,
              eventCount: 5,
              toolCalls: ['Read'],
              errors: 0,
              durationMs: 1200,
              keyMessages: [],
            },
          ],
          nextCursor: null,
          total: 1,
        });
      }
      if (url.includes('/api/sessions/s1/events')) return jsonOk(chatPayload);
      return notFound();
    });

    await renderViewer();
    await switchView('Handoff');

    const invocationId = measuredValue(container, longInvocationId);
    expect(invocationId).toBeTruthy();
    expect(container.querySelector(`[title="${longInvocationId}"]`)).toBeNull();
    if (!invocationId) throw new Error('Expected invocation ID to expose an overflow measurement target');

    await measureInlineOverflow(invocationId);
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制完整Invocation ID"]');
    expect(copy).toBeTruthy();
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(longInvocationId);
  });

  it('keeps the previous view semantically intact while the next view is refreshing', async () => {
    let resolveHandoff: ((response: MockResponse) => void) | undefined;
    const handoffResponse = new Promise<MockResponse>((resolve) => {
      resolveHandoff = resolve;
    });
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.includes('view=handoff')) return handoffResponse;
      if (url.includes('/api/sessions/s1/events')) return jsonOk(chatPayload);
      return notFound();
    });

    await renderViewer();
    await switchView('Handoff');

    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('Refreshing...');
    expect(container.textContent).not.toContain('NaN');

    await act(async () => {
      resolveHandoff?.(await jsonOk(handoffPayload));
      await handoffResponse;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('inv-1');
    expect(container.textContent).not.toContain('hello');
  });

  it('uses an inline diagnostic disclosure for raw events and preserves the full JSON payload', async () => {
    const rawTail = 'raw-event-tail-must-remain-recoverable';
    const rawEvent = {
      eventNo: 41,
      v: 1,
      t: 2000,
      catId: 'codex-sol',
      event: { type: 'tool_result', content: `diagnostic-${'x'.repeat(120)}-${rawTail}` },
    };
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.includes('view=raw')) return jsonOk({ events: [rawEvent], nextCursor: null, total: 1 });
      if (url.includes('/api/sessions/s1/events')) return jsonOk(chatPayload);
      return notFound();
    });

    await renderViewer();
    await switchView('Raw');

    const diagnostic = container.querySelector<HTMLElement>('[data-critical-text-appearance="inline"]');
    expect(diagnostic?.textContent).toContain('#41');
    expect(diagnostic?.textContent).toContain('tool_result');
    expect(container.querySelector(`[title*="${rawTail}"]`)).toBeNull();

    const disclosure = diagnostic?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(disclosure?.textContent).toContain('查看技术详情');
    await act(async () => disclosure?.click());
    expect(diagnostic?.querySelector('pre')?.textContent).toContain(rawTail);
  });
});
