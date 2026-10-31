import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  requestVisiblePageAttestation: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../useHmrStatus', () => ({ useHmrStatus: () => 'idle' }));
vi.mock('../usePreviewBridge', () => ({
  usePreviewBridge: () => ({
    consoleEntries: [],
    consoleOpen: false,
    setConsoleOpen: vi.fn(),
    isCapturing: false,
    screenshotUrl: null,
    handleScreenshot: vi.fn(),
    clearConsole: vi.fn(),
    requestVisiblePageAttestation: mocks.requestVisiblePageAttestation,
  }),
}));

import { previewVisiblePageAdmissionController } from '@/lib/preview-visible-page-admission-controller';
import { BrowserPanel } from '../BrowserPanel';

describe('BrowserPanel same-port path admission', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.requestVisiblePageAttestation.mockReset();
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/preview/status') return { json: async () => ({ available: true, gatewayPort: 4111 }) };
      if (url === '/api/preview/target-health?port=3011') return { json: async () => ({ reachable: true }) };
      return { ok: true, json: async () => ({}) };
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      const pending = previewVisiblePageAdmissionController.getSnapshot();
      if (pending) previewVisiblePageAdmissionController.fail(pending.eventId, 'visible_page_load_error');
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('waits for the new iframe load before requesting proof from a new path on the same port', async () => {
    await act(async () => {
      root.render(<BrowserPanel initialPort={3011} initialPath="/thread/thread-old" previewOnly />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const oldIframe = container.querySelector('iframe');
    if (!oldIframe) throw new Error('BrowserPanel did not render the old iframe');
    await act(async () => oldIframe.dispatchEvent(new Event('load')));
    mocks.requestVisiblePageAttestation.mockClear();

    const request = {
      eventId: 'evt-path-switch',
      port: 3011,
      path: '/thread/thread-new?workspaceView=surface',
      targetOrigin: 'http://preview-3011.localhost:4111',
      admission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    await act(async () => {
      void previewVisiblePageAdmissionController.begin(request);
      root.render(<BrowserPanel initialPort={3011} initialPath={request.path} previewOnly />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.requestVisiblePageAttestation).not.toHaveBeenCalled();

    const newIframe = container.querySelector('iframe');
    if (!newIframe) throw new Error('BrowserPanel did not render the new iframe');
    await act(async () => newIframe.dispatchEvent(new Event('load')));
    expect(mocks.requestVisiblePageAttestation).toHaveBeenCalledWith(request);
  });
});
