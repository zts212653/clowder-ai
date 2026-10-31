import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../useHmrStatus', () => ({ useHmrStatus: () => 'idle' }));
vi.mock('../BrowserToolbar', () => ({ BrowserToolbar: () => <div data-testid="browser-toolbar" /> }));

import { previewVisiblePageAdmissionController } from '@/lib/preview-visible-page-admission-controller';
import { BrowserPanel } from '../BrowserPanel';

describe('BrowserPanel visible-page admission', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
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
    const pending = previewVisiblePageAdmissionController.getSnapshot();
    if (pending) previewVisiblePageAdmissionController.fail(pending.eventId, 'visible_page_load_error');
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('asks the loaded exact-port iframe for proof and resolves the pending delivery', async () => {
    const revision = 'b'.repeat(40);
    const targetOrigin = 'http://preview-3011.localhost:4111';
    const request = {
      eventId: 'evt-browser-panel',
      port: 3011,
      path: '/threads/thread-f307?workspaceView=surface#surface-terminal',
      targetOrigin,
      admission: {
        expectedClientRevision: revision,
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    const resolution = previewVisiblePageAdmissionController.begin(request);

    await act(async () => {
      root.render(<BrowserPanel initialPort={3011} initialPath={request.path} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe(
      'http://preview-3011.localhost:4111/threads/thread-f307?workspaceView=surface#surface-terminal',
    );
    if (!iframe?.contentWindow) throw new Error('BrowserPanel did not render a live iframe');
    const contentWindow = iframe.contentWindow;
    const postMessage = vi.spyOn(contentWindow, 'postMessage');
    await act(async () => {
      iframe.dispatchEvent(new Event('load'));
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'visible-page-admission-request', eventId: request.eventId }),
      targetOrigin,
    );

    const attestation = {
      eventId: request.eventId,
      targetPort: 3011,
      targetOrigin,
      targetPath: request.path,
      clientRevision: revision,
      dom: [{ selector: '[data-layout-owner="f307"]', found: true, attributes: {}, textMatches: [] }],
      forbiddenTextMatches: [],
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: contentWindow,
          origin: targetOrigin,
          data: { source: 'cat-cafe-bridge', type: 'visible-page-attestation', attestation },
        }),
      );
    });
    await expect(resolution).resolves.toEqual({ status: 'attested', attestation });
  });
});
