'use client';

import type { CollectiveHostParticipationReady } from '@cat-cafe/shared';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useContentOpen } from '../content-review/useContentOpen';
import { CollectiveCafeHost } from './CollectiveCafeHost';
import { CollectiveDocumentWorkspace } from './CollectiveDocumentWorkspace';
import { CollectiveEntryReview } from './CollectiveEntryReview';
import {
  CollectiveConnectorBoundary,
  CollectiveLaunchNotice,
  CollectiveServiceSetup,
  CollectiveWorldUnavailable,
} from './CollectiveLaunchChrome';
import { CollectiveMediaShare } from './CollectiveMediaShare';
import { CollectiveMediaSurface } from './CollectiveMediaSurface';
import { hasActiveCollectiveConnection } from './collective-connection-selection';
import { parseCollectiveWorkActionRef } from './collective-work-action';
import { parseCollectiveWorldTarget } from './collective-world-directory';
import { useAcceptedWorkReconciliation } from './use-accepted-work-reconciliation';
import { useCollectiveActionRef } from './use-collective-action-ref';
import { useCollectiveAppearanceBridge } from './use-collective-appearance-bridge';
import { useCollectiveConnectorLaunch } from './use-collective-connector-launch';
import { useCollectiveContextBridge } from './use-collective-context-bridge';
import { useCollectiveDocumentBridge } from './use-collective-document-bridge';
import { useCollectiveEntryPairing } from './use-collective-entry-pairing';
import { useCollectiveFrameRecovery } from './use-collective-frame-recovery';
import { useCollectiveMediaRpc } from './use-collective-media-rpc';
import { useCollectiveMediaShare } from './use-collective-media-share';
import { useCollectivePairingBridge } from './use-collective-pairing-bridge';
import { useCollectiveWorkPolicyBridge } from './use-collective-work-policy-bridge';
import { useCollectiveWorldNavigation } from './use-collective-world-navigation';

const MESSAGE_ACTION_RESERVE = { width: 256, height: 320 } as const;

export function CollectiveLaunchSurface({
  initialServiceUrl = process.env.NEXT_PUBLIC_COLLECTIVE_SERVICE_URL ?? '',
}: {
  readonly initialServiceUrl?: string;
}) {
  const contentOpening = useContentOpen();
  const [documentWorkspace, setDocumentWorkspace] = useState(false);
  const [documentWorkspaceMounted, setDocumentWorkspaceMounted] = useState(false);
  const actionRef = useCollectiveActionRef();
  const workTarget = useMemo(() => parseCollectiveWorkActionRef(actionRef), [actionRef]);
  const parsedWorldTarget = useMemo(() => parseCollectiveWorldTarget(actionRef), [actionRef]);
  const explicitWorldTarget = parsedWorldTarget.kind === 'target' ? parsedWorldTarget.target : undefined;
  const hasExplicitWorldIntent = parsedWorldTarget.kind !== 'none';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameAttempt, setFrameAttempt] = useState(0);
  const workResult = useAcceptedWorkReconciliation();
  const connector = useCollectiveConnectorLaunch({
    initialServiceUrl,
    targetConnectionId: workTarget?.connectionId,
    serviceInputUrl: explicitWorldTarget?.serviceUrl,
    automaticallySelectService: !hasExplicitWorldIntent,
  });
  const entry = useCollectiveEntryPairing(connector.onPaired);
  const world = useCollectiveWorldNavigation({
    iframeRef,
    parsedTarget: parsedWorldTarget,
    status: connector.status,
    selectedConnectionId: connector.selectedConnectionId,
    initialServiceUrl,
    launchUrl: connector.launchUrl,
  });
  const { connection } = world;
  const {
    busy,
    error,
    mutateConnection,
    provisionLocalService,
    selectConnection,
    serviceInput,
    setError,
    setServiceAddress,
    setServiceInput,
    status,
  } = connector;
  const pairingBridge = useCollectivePairingBridge({
    iframeRef,
    serviceUrl: world.activeLaunchUrl,
    pair: entry.receive,
  });
  const contextBridge = useCollectiveContextBridge(iframeRef, connection, workResult.reconcile, workTarget);
  useCollectiveDocumentBridge({
    iframe: iframeRef,
    connection,
    context: contextBridge.context,
    onOpen: (target, hostKey) => {
      void contentOpening.openContent({ kind: 'collective', target, hostKey }).then((opened) => {
        if (opened) {
          setDocumentWorkspaceMounted(true);
          setDocumentWorkspace(true);
        }
      });
    },
    onReturn: () => setDocumentWorkspace(false),
  });
  useEffect(() => {
    const showHost = (event: Event) => {
      const hostKey =
        connection &&
        JSON.stringify([
          'collective',
          connection.serviceInstanceId,
          connection.collectiveId,
          connection.connectionId,
          connection.authorizedHumanId,
        ]);
      if (documentWorkspace || (event as CustomEvent<{ hostKey?: string }>).detail?.hostKey === hostKey)
        setDocumentWorkspace(false);
    };
    window.addEventListener('collective:show-document-host', showHost);
    return () => window.removeEventListener('collective:show-document-host', showHost);
  }, [connection, documentWorkspace]);
  const mediaRpc = useCollectiveMediaRpc(iframeRef, connection, contextBridge.context, contextBridge.mediaRef);
  const mediaShare = useCollectiveMediaShare(iframeRef, connection, contextBridge.context);
  const policyBridge = useCollectiveWorkPolicyBridge(iframeRef, connection, contextBridge.context);
  useCollectiveAppearanceBridge({ iframeRef, frameGeneration: world.frameGeneration });
  const frameUrl = world.frameUrl;
  useCollectiveFrameRecovery({
    iframeRef,
    frameGeneration: world.frameGeneration,
    remoteState: status?.remoteService?.state,
    remoteServiceInstanceId: status?.remoteService?.serviceInstanceId,
    setFrameAttempt,
  });

  if (!status || status.runtimeStatus === 'inactive')
    return <CollectiveConnectorBoundary status={status} error={error} />;

  return (
    <div
      className="cafe-presentation relative h-full min-h-0 overflow-hidden bg-[var(--cafe-surface-canvas)]"
      data-testid="collective-launch-surface"
      style={{ containerType: 'inline-size', containerName: 'collective-host' }}
    >
      {frameUrl ? (
        <CollectiveWorldFrame
          iframeRef={iframeRef}
          frameUrl={frameUrl}
          frameKey={world.frameKey}
          frameAttempt={frameAttempt}
          hidden={Boolean(documentWorkspace || contextBridge.mediaRef || mediaShare.reference)}
          onLoad={() => {
            pairingBridge.handleFrameLoad();
            contextBridge.reset();
          }}
          retryable={world.retryable}
          error={world.error}
          displayName={world.displayName}
          onRetry={() => {
            setFrameAttempt((attempt) => attempt + 1);
            void connector.refresh(true);
          }}
        />
      ) : (
        <CollectiveServiceSetup
          status={status}
          busy={busy}
          serviceInput={serviceInput}
          onServiceInput={setServiceInput}
          onProvision={() => void provisionLocalService()}
          onOpen={setServiceAddress}
          onError={setError}
        />
      )}
      <CollectiveWorldStatusNotice
        connectorError={error}
        worldError={world.error}
        worldRetryable={world.retryable}
        sessionRequired={world.sessionRequired}
        workNotice={workResult.notice}
        pairingError={pairingBridge.error}
        entryError={entry.error}
        entryBusy={entry.busy}
      />
      {documentWorkspaceMounted && (
        <CollectiveDocumentWorkspace visible={documentWorkspace} onBack={() => setDocumentWorkspace(false)} />
      )}
      {connection && contextBridge.context && (
        <CollectiveCafeHost
          key={`${connection.connectionId}:${contextBridge.context.contextId}:${contextBridge.context.channelId}`}
          connection={connection}
          context={contextBridge.context}
          iframeRef={iframeRef}
          policyBridge={policyBridge}
          onParticipationReady={({ revision, catCount }) => {
            const activeContext = contextBridge.context;
            if (!activeContext) return;
            const message: CollectiveHostParticipationReady = {
              type: 'collective:host-participation-ready',
              bridgeId: activeContext.bridgeId,
              serviceInstanceId: connection.serviceInstanceId,
              collectiveId: connection.collectiveId,
              connectionId: connection.connectionId,
              humanId: activeContext.humanId,
              participationRevision: revision,
              catCount,
            };
            iframeRef.current?.contentWindow?.postMessage(message, new URL(connection.serviceUrl).origin);
          }}
          busy={busy}
          pairingState={pairingBridge.state}
          onClose={contextBridge.close}
          onOpenMembers={contextBridge.openMembers}
          onPair={pairingBridge.requestPairing}
          onMutate={(operation) => void mutateConnection(operation, connection.connectionId)}
          connections={status.connections}
          onSelectConnection={(id) => {
            const selected = status.connections.find((item) => item.connectionId === id);
            if (!selected) return;
            contextBridge.close();
            selectConnection(selected);
          }}
        />
      )}
      {entry.pending && (
        <CollectiveEntryReview
          intent={entry.pending}
          existing={hasActiveCollectiveConnection(
            status.connections,
            entry.pending.intent.serviceInstanceId,
            entry.pending.intent.collectiveId,
          )}
          busy={entry.busy}
          pairingError={entry.error}
          onConfirm={(selection) => void entry.confirm(selection)}
          onClose={entry.clear}
          onRetry={entry.clearError}
        />
      )}
      {contextBridge.mediaRef && (
        <CollectiveMediaSurface
          key={JSON.stringify(contextBridge.mediaRef)}
          reference={contextBridge.mediaRef}
          rpc={mediaRpc}
          onBack={contextBridge.closeMedia}
        />
      )}
      {mediaShare.reference && (
        <CollectiveMediaShare
          key={JSON.stringify(mediaShare.reference)}
          reference={mediaShare.reference}
          onDone={mediaShare.finish}
        />
      )}
    </div>
  );
}

function CollectiveWorldFrame({
  iframeRef,
  frameUrl,
  frameKey,
  frameAttempt,
  hidden,
  onLoad,
  retryable,
  error,
  displayName,
  onRetry,
}: {
  readonly iframeRef: RefObject<HTMLIFrameElement>;
  readonly frameUrl: string;
  readonly frameKey?: string;
  readonly frameAttempt: number;
  readonly hidden: boolean;
  readonly onLoad: () => void;
  readonly retryable: boolean;
  readonly error?: string;
  readonly displayName?: string;
  readonly onRetry: () => void;
}) {
  return (
    <>
      <iframe
        key={`${frameKey ?? frameUrl}:${frameAttempt}`}
        ref={iframeRef}
        src={frameUrl}
        title="Collective"
        aria-hidden={hidden}
        tabIndex={hidden ? -1 : undefined}
        style={hidden ? { visibility: 'hidden' } : undefined}
        sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="microphone"
        onLoad={onLoad}
        className="h-full w-full border-0 bg-[var(--cafe-surface-sunken)]"
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: `min(${MESSAGE_ACTION_RESERVE.width}px, 100%)`,
          height: `min(${MESSAGE_ACTION_RESERVE.height}px, 100%)`,
          pointerEvents: 'none',
        }}
      />
      {retryable && error && <CollectiveWorldUnavailable name={displayName} onRetry={onRetry} />}
    </>
  );
}

function CollectiveWorldStatusNotice({
  connectorError,
  worldError,
  worldRetryable,
  sessionRequired,
  workNotice,
  pairingError,
  entryError,
  entryBusy,
}: {
  readonly connectorError?: string;
  readonly worldError?: string;
  readonly worldRetryable: boolean;
  readonly sessionRequired: boolean;
  readonly workNotice?: string;
  readonly pairingError?: string;
  readonly entryError?: string;
  readonly entryBusy?: boolean;
}) {
  return (
    <CollectiveLaunchNotice
      connectorError={connectorError}
      worldError={worldRetryable ? undefined : worldError}
      sessionRequired={sessionRequired}
      workNotice={workNotice}
      pairingError={worldRetryable ? undefined : pairingError}
      entryError={worldRetryable ? undefined : entryError}
      entryBusy={worldRetryable ? false : entryBusy}
    />
  );
}
