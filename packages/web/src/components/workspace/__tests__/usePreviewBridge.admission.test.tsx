import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PreviewVisiblePageAdmissionController,
  PreviewVisiblePageAdmissionRequest,
} from '@/lib/preview-visible-page-admission-controller';
import { usePreviewBridge } from '../usePreviewBridge';

const request: PreviewVisiblePageAdmissionRequest = {
  eventId: 'evt-f307',
  port: 3011,
  path: '/threads/thread-f307?workspaceView=surface',
  targetOrigin: 'http://preview-3011.localhost:4111',
  admission: {
    expectedClientRevision: 'b'.repeat(40),
    requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
  },
};
const WORKBENCH_SELECTOR = '[data-layout-owner="f307"]';

function Harness({
  onReady,
  onAttestation,
}: {
  onReady: (send: (request: PreviewVisiblePageAdmissionRequest) => boolean, iframe: HTMLIFrameElement) => void;
  onAttestation: PreviewVisiblePageAdmissionController['attest'];
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { requestVisiblePageAttestation } = usePreviewBridge(iframeRef, 4111, 3011, onAttestation);
  useEffect(() => {
    if (iframeRef.current) onReady(requestVisiblePageAttestation, iframeRef.current);
  }, [onReady, requestVisiblePageAttestation]);
  return <iframe ref={iframeRef} title="admission target" />;
}

describe('usePreviewBridge visible-page admission', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('requests proof only from the exact gateway origin and accepts its matching iframe response', async () => {
    const onAttestation = vi.fn();
    const bridge: {
      send?: (value: PreviewVisiblePageAdmissionRequest) => boolean;
      iframe?: HTMLIFrameElement;
    } = {};
    await act(async () => {
      root.render(
        <Harness
          onAttestation={onAttestation}
          onReady={(nextSend, nextIframe) => {
            bridge.send = nextSend;
            bridge.iframe = nextIframe;
          }}
        />,
      );
    });

    if (!bridge.iframe?.contentWindow || !bridge.send) throw new Error('Harness did not expose its iframe bridge');
    const contentWindow = bridge.iframe.contentWindow;
    const postMessage = vi.spyOn(contentWindow, 'postMessage');
    expect(bridge.send(request)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'visible-page-admission-request',
        eventId: 'evt-f307',
        targetPort: 3011,
      }),
      request.targetOrigin,
    );

    const attestation = {
      eventId: 'evt-f307',
      targetPort: 3011,
      targetOrigin: request.targetOrigin,
      targetPath: request.path,
      clientRevision: 'b'.repeat(40),
      dom: [{ selector: WORKBENCH_SELECTOR, found: true, attributes: {}, textMatches: [] }],
      forbiddenTextMatches: [],
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: contentWindow,
          origin: request.targetOrigin,
          data: { source: 'cat-cafe-bridge', type: 'visible-page-attestation', attestation },
        }),
      );
    });
    expect(onAttestation).toHaveBeenCalledWith(attestation);

    window.dispatchEvent(
      new MessageEvent('message', {
        source: contentWindow,
        origin: 'http://preview-3001.localhost:4111',
        data: { source: 'cat-cafe-bridge', type: 'visible-page-attestation', attestation },
      }),
    );
    expect(onAttestation).toHaveBeenCalledTimes(1);
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
