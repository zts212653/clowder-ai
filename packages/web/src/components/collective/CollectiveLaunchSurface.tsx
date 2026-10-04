'use client';

import type { CollectiveHostParticipationReady } from '@cat-cafe/shared';

import { useMemo, useRef } from 'react';
import { CollectiveCafeHost } from './CollectiveCafeHost';
import { CollectiveEntryReview } from './CollectiveEntryReview';
import {
  CollectiveConnectionPicker,
  CollectiveConnectorBoundary,
  CollectiveLaunchNotice,
  CollectiveServiceSetup,
} from './CollectiveLaunchChrome';
import { hasActiveCollectiveConnection } from './collective-connection-selection';
import { parseCollectiveWorkActionRef } from './collective-work-action';
import { parseCollectiveWorldTarget } from './collective-world-directory';
import { useAcceptedWorkReconciliation } from './use-accepted-work-reconciliation';
import { useCollectiveActionRef } from './use-collective-action-ref';
import { useCollectiveAppearanceBridge } from './use-collective-appearance-bridge';
import { useCollectiveConnectorLaunch } from './use-collective-connector-launch';
import { useCollectiveContextBridge } from './use-collective-context-bridge';
import { useCollectiveEntryPairing } from './use-collective-entry-pairing';
import { useCollectivePairingBridge } from './use-collective-pairing-bridge';
import { useCollectiveWorkPolicyBridge } from './use-collective-work-policy-bridge';
import { useCollectiveWorldNavigation } from './use-collective-world-navigation';

const MESSAGE_ACTION_RESERVE = { width: 256, height: 320 } as const;

export function CollectiveLaunchSurface({
  initialServiceUrl = process.env.NEXT_PUBLIC_COLLECTIVE_SERVICE_URL ?? '',
}: {
  readonly initialServiceUrl?: string;
}) {
  const actionRef = useCollectiveActionRef();
  const workTarget = useMemo(() => parseCollectiveWorkActionRef(actionRef), [actionRef]);
  const parsedWorldTarget = useMemo(() => parseCollectiveWorldTarget(actionRef), [actionRef]);
  const explicitWorldTarget = parsedWorldTarget.kind === 'target' ? parsedWorldTarget.target : undefined;
  const hasExplicitWorldIntent = parsedWorldTarget.kind !== 'none';
  const iframeRef = useRef<HTMLIFrameElement>(null);
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
  const liveConnections = status?.connections.filter((item) => item.authorityStatus !== 'revoked') ?? [];
  const pairingBridge = useCollectivePairingBridge({
    iframeRef,
    serviceUrl: world.activeLaunchUrl,
    pair: entry.receive,
  });
  const contextBridge = useCollectiveContextBridge(iframeRef, connection, workResult.reconcile, workTarget);
  const policyBridge = useCollectiveWorkPolicyBridge(iframeRef, connection, contextBridge.context);
  useCollectiveAppearanceBridge({ iframeRef, frameGeneration: world.frameGeneration });
  const frameUrl = world.frameUrl;

  if (!status || status.runtimeStatus === 'inactive')
    return <CollectiveConnectorBoundary status={status} error={error} />;

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-[var(--cafe-surface-canvas)]"
      data-testid="collective-launch-surface"
      style={{ containerType: 'inline-size', containerName: 'collective-host' }}
    >
      {frameUrl ? (
        <iframe
          ref={iframeRef}
          src={frameUrl}
          title="Collective"
          sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          onLoad={() => {
            pairingBridge.handleFrameLoad();
            contextBridge.reset();
          }}
          className="h-full w-full border-0 bg-[var(--cafe-surface-sunken)]"
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
      {frameUrl && (
        <div
          aria-hidden="true"
          data-concierge-reserved-rect="collective-message-actions"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: `min(${MESSAGE_ACTION_RESERVE.width}px, 100%)`,
            height: `min(${MESSAGE_ACTION_RESERVE.height}px, 100%)`,
            pointerEvents: 'none',
          }}
        />
      )}
      <CollectiveLaunchNotice
        connectorError={error}
        worldError={world.error}
        workError={workResult.error}
        pairingError={pairingBridge.error}
        entryError={entry.error}
        entryBusy={entry.busy}
      />
      <CollectiveConnectionPicker
        visible={!hasExplicitWorldIntent && liveConnections.length > 1 && !connection}
        connections={liveConnections}
        onSelect={selectConnection}
      />
      {connection && contextBridge.context && (
        <CollectiveCafeHost
          key={`${connection.connectionId}:${contextBridge.context.contextId}:${contextBridge.context.channelId}`}
          connection={connection}
          context={contextBridge.context}
          policyBridge={policyBridge}
          onOpen={contextBridge.open}
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
    </div>
  );
}
