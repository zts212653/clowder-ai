'use client';

import {
  type CollectivePairingIntentMessage,
  type CollectivePairingMessage,
  collectivePairingMessageSchema,
} from '@cat-cafe/shared';
import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeCollectiveServiceUrl } from './collective-client';

type PairingBridgeState = 'waiting' | 'ready' | 'unavailable';

interface PairingBridgeOptions {
  readonly iframeRef: RefObject<HTMLIFrameElement>;
  readonly serviceUrl: string | undefined;
  readonly pair: (message: CollectivePairingIntentMessage) => void | Promise<void>;
}

interface PairingBridgeProjection {
  readonly serviceUrl: string | undefined;
  readonly state: PairingBridgeState;
  readonly error?: string;
}

function pairingErrorMessage(code: 'session_required' | 'collective_required' | 'client_unavailable'): string {
  if (code === 'collective_required') return '请先建立第一个 Collective，再重新配对';
  if (code === 'client_unavailable') return 'Collective 客户端暂时不可用，请稍后重试';
  return '请先在 Collective 登录，再重新配对';
}

function trustedPairingMessage(
  event: MessageEvent<unknown>,
  iframe: HTMLIFrameElement | null,
  serviceUrl: string | undefined,
): CollectivePairingMessage | undefined {
  const parsed = collectivePairingMessageSchema.safeParse(event.data);
  if (!parsed.success || !serviceUrl) return undefined;
  if (event.source !== iframe?.contentWindow || event.origin !== serviceUrl) return undefined;
  return normalizeCollectiveServiceUrl(parsed.data.serviceUrl) === serviceUrl ? parsed.data : undefined;
}

function statusProjection(message: CollectivePairingMessage): Omit<PairingBridgeProjection, 'serviceUrl'> | undefined {
  if (message.type === 'collective:pairing-ready') return { state: 'ready' };
  if (message.type !== 'collective:pairing-error') return undefined;
  return message.code === 'pairing_failed'
    ? { state: 'ready', error: 'Collective 暂时没能创建新的配对邀请，请重试' }
    : { state: 'unavailable', error: pairingErrorMessage(message.code) };
}

export function useCollectivePairingBridge({ iframeRef, serviceUrl, pair }: PairingBridgeOptions) {
  const [stored, setStored] = useState<PairingBridgeProjection>({ serviceUrl, state: 'waiting' });
  const current = useMemo<PairingBridgeProjection>(
    () => (stored.serviceUrl === serviceUrl ? stored : { serviceUrl, state: 'waiting' }),
    [serviceUrl, stored],
  );
  const project = useCallback(
    (projection: Omit<PairingBridgeProjection, 'serviceUrl'>) => setStored({ serviceUrl, ...projection }),
    [serviceUrl],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = trustedPairingMessage(event, iframeRef.current, serviceUrl);
      if (!message) return;
      const status = statusProjection(message);
      if (status) return project(status);
      if (message.type !== 'collective:pairing-intent') return;
      if (new URL(message.intent.hostOrigin).origin !== window.location.origin) return;
      project({ state: 'ready' });
      void pair(message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [iframeRef, pair, project, serviceUrl]);

  const requestPairing = useCallback(() => {
    if (current.state !== 'ready' || !serviceUrl || !iframeRef.current?.contentWindow) {
      project({ state: current.state, error: 'Collective 客户端尚未准备好，请稍后重试' });
      return;
    }
    project({ state: 'ready' });
    iframeRef.current.contentWindow.postMessage({ type: 'collective:request-pairing' }, serviceUrl);
  }, [current.state, iframeRef, project, serviceUrl]);

  const handleFrameLoad = useCallback(() => {
    project({ state: 'waiting' });
    if (!serviceUrl) return;
    iframeRef.current?.contentWindow?.postMessage({ type: 'collective:request-pairing-status' }, serviceUrl);
  }, [iframeRef, project, serviceUrl]);

  return { state: current.state, error: current.error, requestPairing, handleFrameLoad };
}
