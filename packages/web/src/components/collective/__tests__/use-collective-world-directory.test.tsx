// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollectiveWorldDirectory } from '../use-collective-world-directory';

function Harness({ iframe }: { readonly iframe: HTMLIFrameElement }) {
  const iframeRef = useRef(iframe);
  const bridge = useCollectiveWorldDirectory({
    iframeRef,
    serviceUrl: 'http://localhost:5201',
    expectedServiceInstanceId: 'svc_12345678',
  });
  return (
    <button
      type="button"
      data-generation={
        bridge.frameGeneration ? `${bridge.frameGeneration.bridgeId}@${bridge.frameGeneration.serviceOrigin}` : ''
      }
      onClick={() => bridge.selectWorld('col_87654321')}
    >
      {bridge.failure ?? bridge.directory?.state ?? 'loading'}
    </button>
  );
}

describe('useCollectiveWorldDirectory', () => {
  let container: HTMLDivElement;
  let root: Root;
  let iframe: HTMLIFrameElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bridge_12345678');
    container = document.createElement('div');
    iframe = document.createElement('iframe');
    document.body.append(container, iframe);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    iframe.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('mints a fresh generation, accepts one newer directory and posts an exact selection', async () => {
    const frame = iframe.contentWindow;
    if (!frame) throw new Error('Expected iframe contentWindow');
    const postMessage = vi.spyOn(frame, 'postMessage');
    await act(async () => root.render(<Harness iframe={iframe} />));
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: { type: 'collective:world-directory-ready' },
        }),
      );
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'collective:host-world-directory-init',
        bridgeId: 'bridge_12345678',
        expectedServiceInstanceId: 'svc_12345678',
      },
      'http://localhost:5201',
    );

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: {
            type: 'collective:client-world-directory',
            bridgeId: 'bridge_12345678',
            revision: 1,
            state: 'ready',
            serviceInstanceId: 'svc_12345678',
            humanId: 'human_12345678',
            currentCollectiveId: 'col_12345678',
            memberships: [
              { collectiveId: 'col_12345678', name: 'Alpha', role: 'steward' },
              { collectiveId: 'col_87654321', name: 'Invite-only room', role: 'member' },
            ],
          },
        }),
      );
    });
    expect(container.textContent).toBe('ready');

    await act(async () => container.querySelector('button')?.click());
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'collective:host-select-world',
        bridgeId: 'bridge_12345678',
        directoryRevision: 1,
        serviceInstanceId: 'svc_12345678',
        humanId: 'human_12345678',
        collectiveId: 'col_87654321',
      },
      'http://localhost:5201',
    );
  });

  it('surfaces a current-generation Service identity mismatch without accepting its directory', async () => {
    await act(async () => root.render(<Harness iframe={iframe} />));
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: { type: 'collective:world-directory-ready' },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: {
            type: 'collective:client-world-directory',
            bridgeId: 'bridge_12345678',
            revision: 1,
            state: 'ready',
            serviceInstanceId: 'svc_changed000',
            humanId: 'human_12345678',
            memberships: [],
          },
        }),
      );
    });
    expect(container.textContent).toBe('service_mismatch');
  });

  it('lets others observe the current frame generation read-only: none before the handshake, the minted one after, a new one on a new handshake', async () => {
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('bridge_aaaaaaaa');
    const generation = () => container.querySelector('button')?.getAttribute('data-generation');
    const handshake = async (source: MessageEventSource | null, origin = 'http://localhost:5201') =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', { origin, source, data: { type: 'collective:world-directory-ready' } }),
        );
      });
    await act(async () => root.render(<Harness iframe={iframe} />));
    expect(generation()).toBe('');

    await handshake(window, 'http://localhost:5201');
    await handshake(iframe.contentWindow, 'http://evil.test');
    expect(generation()).toBe('');

    await handshake(iframe.contentWindow);
    expect(generation()).toBe('bridge_aaaaaaaa@http://localhost:5201');

    uuid.mockReturnValue('bridge_bbbbbbbb');
    await handshake(iframe.contentWindow);
    expect(generation()).toBe('bridge_bbbbbbbb@http://localhost:5201');
  });
});
