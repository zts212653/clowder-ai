import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { WorkspacePluginFilePreview } from '../WorkspacePluginFilePreview';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/content-review/FileActions', () => ({ FileActions: () => null }));

const origin = 'http://editor-00000000000000000000000000000000.localhost:56123';

describe('WorkspacePluginFilePreview', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const port1 = { close: vi.fn(), postMessage: vi.fn() };
  const port2 = {};

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = port1;
        port2 = port2;
      },
    );
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          rendererOrigin: origin,
          entrypointPath: '/packages/1a2b/assets/preview/index.html',
          bridgeVersion: '1.0.0',
          fileName: 'sample.pdf',
          mediaType: 'application/pdf',
          bytesBase64: 'cGRm',
        }),
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  async function open() {
    await act(async () => {
      root.render(
        <WorkspacePluginFilePreview
          target={{ worktreeId: 'project', path: 'docs/sample.pdf' }}
          onBack={() => undefined}
          showPluginSettings
          fallback={<p>System application fallback</p>}
        />,
      );
    });
    const frame = container.querySelector('iframe');
    if (!frame?.contentWindow) throw new Error('Renderer iframe missing');
    const source = frame.contentWindow;
    const postMessage = vi.spyOn(source, 'postMessage');
    const fragment = new URLSearchParams(new URL(frame.src).hash.slice(1));
    const handshakeNonce = fragment.get('cat-cafe-handshake');

    const ready = (bridgeVersion?: string, eventOrigin = origin) => {
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source,
            origin: eventOrigin,
            data: { v: 1, kind: 'cat-cafe-content-preview-ready', handshakeNonce, bridgeVersion },
          }),
        ),
      );
    };
    return { ready, handshakeNonce, postMessage };
  }

  it('delivers one snapshot only after an exact renderer and protocol match', async () => {
    const { ready, handshakeNonce, postMessage } = await open();
    ready('1.0.0', 'http://localhost:56123');
    expect(postMessage).not.toHaveBeenCalled();
    ready('1.0.0');
    ready('1.0.0');
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { v: 1, kind: 'cat-cafe-content-preview-connect', bridgeVersion: '1.0.0', handshakeNonce },
      origin,
      [port2],
    );
    expect(port1.postMessage).toHaveBeenCalledOnce();
    expect(port1.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, '2.0.0'])('falls back before transfer for renderer version %s', async (version) => {
    const { ready, postMessage } = await open();
    ready(version);
    expect(postMessage).not.toHaveBeenCalled();
    expect(port1.postMessage).not.toHaveBeenCalled();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('System application fallback');
  });
});
