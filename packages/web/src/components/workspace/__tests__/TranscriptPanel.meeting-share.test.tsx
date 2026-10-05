import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://test',
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setFloatingTranscriptVisible: () => {}, currentThreadId: 'test-thread' }),
}));
vi.stubGlobal(
  'EventSource',
  class FakeEventSource {
    close() {}
  },
);

it('keeps the private share action beside an active capture and revokes before Stop', async () => {
  (globalThis as Record<string, unknown>).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: string[] = [];
  const ordinaryResponses = {
    '/api/audio/status': {
      running: true,
      inputs: [{ id: 'app-1', source: 'app', label: 'Local test app', state: 'running' }],
    },
    '/api/audio/transcript': { lines: [] },
    '/api/audio/sources': { apps: [], mics: [] },
  };
  mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const ordinary = ordinaryResponses[path as keyof typeof ordinaryResponses];
    if (ordinary) return { ok: true, json: async () => ordinary };
    if (path === '/api/concierge/meeting-share' && !init?.method)
      return {
        ok: true,
        json: async () => ({
          kind: 'available',
          intent: {
            callId: 'call-1',
            generation: 1,
            captureThreadId: 'test-thread',
            meetingId: 'mtg-1',
            captureStartedAt: 100,
            inputId: 'app-1',
            inputLabel: 'Local test app',
          },
          catId: 'codex6-sol',
          inputLabel: 'Local test app',
          sharing: false,
        }),
      };
    if (path === '/api/audio/stop') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ sharing: false }) };
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const { TranscriptPanel } = await import('../TranscriptPanel');
    await act(async () => {
      root.render(<TranscriptPanel />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain('Share transcript');
    const stop = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Stop');
    await act(async () => {
      stop?.click();
    });
    const revokeAt = calls.indexOf('DELETE /api/concierge/meeting-share');
    const stopAt = calls.indexOf('POST /api/audio/stop');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(revokeAt);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

for (const [control, audioPath] of [
  ['Stop', '/api/audio/stop'],
  ['Pause', '/api/audio/pause'],
] as const) {
  it(`${control} continues promptly when optional meeting-share DELETE hangs`, async () => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockApiFetch.mockReset();
    const calls: string[] = [];
    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/concierge/meeting-share' && init?.method === 'DELETE') {
        return new Promise(() => {});
      }
      if (path === '/api/concierge/meeting-share') {
        return { ok: true, json: async () => ({ kind: 'unavailable' }) };
      }
      if (path === '/api/audio/status') {
        return {
          ok: true,
          json: async () => ({
            running: true,
            inputs: [{ id: 'app-1', source: 'app', label: 'Local test app', state: 'running' }],
          }),
        };
      }
      if (path === '/api/audio/transcript') return { ok: true, json: async () => ({ lines: [] }) };
      if (path === '/api/audio/sources') return { ok: true, json: async () => ({ apps: [], mics: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      const { TranscriptPanel } = await import('../TranscriptPanel');
      await act(async () => {
        root.render(<TranscriptPanel />);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === control);
      expect(button).toBeTruthy();
      await act(async () => {
        button?.click();
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(calls).toContain(`DELETE /api/concierge/meeting-share`);
      expect(calls).toContain(`POST ${audioPath}`);
    } finally {
      act(() => root.unmount());
      container.remove();
      delete (globalThis as Record<string, unknown>).React;
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
}
