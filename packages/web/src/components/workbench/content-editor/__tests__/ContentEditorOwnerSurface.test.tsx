import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentEditorOwnerSurface } from '../ContentEditorOwnerSurface';

const sessionRef = `editor-session:${'a'.repeat(64)}`;
const sessionToken = `editor_${'b'.repeat(40)}`;
const surfaceIntegrity = `sha256-${'A'.repeat(43)}=`;

function admission(overrides: Record<string, unknown> = {}) {
  return {
    sessionRef,
    sessionToken,
    surface: {
      v: 1,
      kind: 'f202-content-editor-surface-admission',
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      packageDigest: 'sha512-package-1',
      grantRevision: 1,
      lifecycleRevision: 1,
      activationState: 'enabled',
      runtimeState: 'healthy',
      rendererOrigin: 'https://renderer.plugin.invalid',
      entrypointPath: '/packages/package-1/assets/renderer/index.html',
      surfaceIntegrity,
      bridgeVersion: '1.0.0',
      sandbox: 'dedicated-origin-iframe',
      framingPolicy: {
        kind: 'csp-frame-ancestors',
        parentOrigin: window.location.origin,
      },
      navigationPolicy: 'navigation-api-deny',
      ...overrides,
    },
  };
}

class FakePort {
  listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
  addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }
}

describe('ContentEditorOwnerSurface', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let port1: FakePort;
  let port2: FakePort;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    port1 = new FakePort();
    port2 = new FakePort();
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = port1;
        port2 = port2;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('resumes by public ref, mounts only the admitted dedicated-origin renderer, and transfers one bridge port', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(admission()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await act(async () => {
      root.render(
        <ContentEditorOwnerSurface
          target={{ contentRef: 'project:alpha/assets/proposal.docx', sessionRef }}
          apiBase="http://localhost:3102"
          fetchImpl={fetchImpl}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `http://localhost:3102/api/collaborative-content/editor-sessions/${encodeURIComponent(sessionRef)}/resume`,
      expect.objectContaining({ method: 'POST', credentials: 'include', body: '{}' }),
    );
    const iframe = container.querySelector('iframe');
    const rendererUrl = new URL(iframe?.getAttribute('src') ?? '');
    expect(`${rendererUrl.origin}${rendererUrl.pathname}`).toBe(
      'https://renderer.plugin.invalid/packages/package-1/assets/renderer/index.html',
    );
    const handshakeNonce = rendererUrl.hash
      .slice(1)
      .split('&')
      .find((item) => item.startsWith('cat-cafe-handshake='))
      ?.split('=')[1];
    expect(handshakeNonce).toMatch(/^handshake_[A-Za-z0-9_-]{32,}$/);
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    if (!iframe?.contentWindow) throw new Error('renderer iframe missing');
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');
    act(() => iframe.dispatchEvent(new Event('load')));
    expect(postMessage).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          origin: 'https://renderer.plugin.invalid',
          data: {
            v: 1,
            kind: 'cat-cafe-content-editor-ready',
            bridgeVersion: '1.0.0',
            handshakeNonce: decodeURIComponent(handshakeNonce ?? ''),
          },
        }),
      );
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        v: 1,
        kind: 'cat-cafe-content-editor-connect',
        bridgeVersion: '1.0.0',
        sessionToken,
        handshakeNonce: decodeURIComponent(handshakeNonce ?? ''),
      },
      'https://renderer.plugin.invalid',
      [port2],
    );
    expect(port1.start).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="content-editor-connected"]')).not.toBeNull();

    act(() => iframe.dispatchEvent(new Event('load')));
    await act(async () => Promise.resolve());
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          origin: 'https://renderer.plugin.invalid',
          data: {
            v: 1,
            kind: 'cat-cafe-content-editor-ready',
            bridgeVersion: '1.0.0',
            handshakeNonce: decodeURIComponent(handshakeNonce ?? ''),
          },
        }),
      );
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(port1.close).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://localhost:3102/api/collaborative-content/editor-sessions/${encodeURIComponent(sessionRef)}`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
    expect(container.querySelector('[data-testid="content-editor-unavailable"]')).not.toBeNull();
  });

  it('shows revoked authority while retaining the document frame and unsaved edits until explicit reopen', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).endsWith('/editor-bridge')
              ? { ok: false, error: { code: 'authority_changed', message: 'Plugin disabled' } }
              : admission(),
          ),
          { status: String(input).endsWith('/editor-bridge') ? 409 : 200 },
        ),
    );
    await act(async () => {
      root.render(
        <ContentEditorOwnerSurface
          target={{ contentRef: 'doc', sessionRef }}
          apiBase="http://localhost:3102"
          fetchImpl={fetchImpl}
        />,
      );
    });
    const frame = container.querySelector('iframe')!;
    const url = new URL(frame.src);
    const nonce = new URLSearchParams(url.hash.slice(1)).get('cat-cafe-handshake');
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: url.origin,
          data: { v: 1, kind: 'cat-cafe-content-editor-ready', bridgeVersion: '1.0.0', handshakeNonce: nonce },
        }),
      ),
    );
    await act(async () => {
      for (const listener of port1.listeners)
        listener(
          new MessageEvent('message', {
            data: {
              v: 1,
              kind: 'cat-cafe-content-editor-request',
              sessionToken,
              requestId: 'after-disable',
              operation: 'content.load',
              payload: {},
            },
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="content-editor-disconnected"]')?.textContent).toContain('未保存');
    expect(container.querySelector('iframe')).toBe(frame);
    expect(port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), []);
  });

  it('shows an honest unavailable state and never mounts malformed or mismatched admission data', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...admission({
              rendererOrigin: 'http://localhost:3102',
              entrypointPath: '/api/plugins/packages/package-1/assets/renderer/index.html',
            }),
            sessionRef: `editor-session:${'f'.repeat(64)}`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await act(async () => {
      root.render(
        <ContentEditorOwnerSurface
          target={{ contentRef: 'project:alpha/assets/proposal.docx', sessionRef }}
          apiBase="http://localhost:3102"
          fetchImpl={fetchImpl}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-testid="content-editor-unavailable"]')?.textContent).toContain(
      '编辑器暂不可用',
    );
  });

  it('rejects a typed F202 admission whose framing parent is not this Host origin', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            admission({
              framingPolicy: {
                kind: 'csp-frame-ancestors',
                parentOrigin: 'https://other-host.invalid',
              },
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await act(async () => {
      root.render(
        <ContentEditorOwnerSurface
          target={{ contentRef: 'project:alpha/assets/proposal.docx', sessionRef }}
          apiBase="http://localhost:3102"
          fetchImpl={fetchImpl}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-testid="content-editor-unavailable"]')).not.toBeNull();
  });

  it('revokes an admission that never completes the renderer-ready handshake', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(admission()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await act(async () => {
      root.render(
        <ContentEditorOwnerSurface
          target={{ contentRef: 'project:alpha/assets/proposal.docx', sessionRef }}
          apiBase="http://localhost:3102"
          fetchImpl={fetchImpl}
          handshakeTimeoutMs={1}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(container.querySelector('[data-testid="content-editor-unavailable"]')).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://localhost:3102/api/collaborative-content/editor-sessions/${encodeURIComponent(sessionRef)}`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
    vi.useRealTimers();
  });
});
