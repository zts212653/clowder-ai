import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://test',
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      floatingTranscriptVisible: true,
      setFloatingTranscriptVisible: () => {},
      currentThreadId: 'thread-floating-error',
    }),
}));

vi.mock('react-rnd', () => ({
  Rnd: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

vi.stubGlobal('EventSource', FakeEventSource);

describe('FloatingTranscriptContainer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let startBodies: Array<Record<string, unknown>>;

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
    startBodies = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/audio/status') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ running: false }) });
      }
      if (path === '/api/audio/transcript') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ lines: [] }) });
      }
      if (path === '/api/audio/sources') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              apps: [{ id: 'com.huawei.cloudlink', name: 'Huawei Cloud Meeting' }],
              mics: [],
            }),
        });
      }
      if (path === '/api/audio/start' && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'CAM++ model missing' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('surfaces a failed start response in the floating window', async () => {
    const { FloatingTranscriptContainer } = await import('../FloatingTranscriptContainer');

    await act(async () => {
      root.render(<FloatingTranscriptContainer />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const appSelect = document.querySelector('select[aria-label="App audio"]') as HTMLSelectElement;
    await act(async () => {
      appSelect.value = 'com.huawei.cloudlink';
      appSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const startButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Start'),
    );
    expect(startButton).toBeDefined();

    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(document.body.textContent).toContain('CAM++ model missing');
    expect(startBodies).toEqual([
      {
        inputs: [
          {
            id: 'app',
            source: 'app',
            app_name: 'com.huawei.cloudlink',
            label: 'Huawei Cloud Meeting',
          },
        ],
        thread_id: 'thread-floating-error',
      },
    ]);
  });
});
