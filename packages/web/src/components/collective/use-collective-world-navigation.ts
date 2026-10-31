'use client';

import { type RefObject, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  type CollectiveConnectionProjection,
  type CollectiveConnectorStatus,
  canonicalClientUrl,
  normalizeCollectiveServiceUrl,
} from './collective-client';
import { preferredConnection } from './collective-connection-selection';
import { type ParsedCollectiveWorldTarget, resolveExplicitWorldTarget } from './collective-world-directory';
import { getWorldDirectoryStoreSnapshot, subscribeWorldDirectoryStore } from './collective-world-directory-store';
import { useCollectiveWorldDirectory } from './use-collective-world-directory';

export function useCollectiveWorldNavigation(input: {
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly parsedTarget: ParsedCollectiveWorldTarget;
  readonly status?: CollectiveConnectorStatus;
  readonly selectedConnectionId?: string;
  readonly initialServiceUrl: string;
  readonly launchUrl?: string;
}) {
  const explicitTarget = input.parsedTarget.kind === 'target' ? input.parsedTarget.target : undefined;
  const hasExplicitIntent = input.parsedTarget.kind !== 'none';
  const connection = resolveWorldConnection(
    input.status,
    input.parsedTarget,
    input.selectedConnectionId,
    input.launchUrl,
  );
  const explicitServiceKnown = serviceIsKnown(input.status, explicitTarget);
  const explicitServiceApproved = Boolean(
    explicitTarget &&
      (explicitServiceKnown ||
        sameService(input.initialServiceUrl, explicitTarget.serviceUrl) ||
        sameService(input.launchUrl, explicitTarget.serviceUrl)),
  );
  const activeLaunchUrl = hasExplicitIntent
    ? explicitTarget && explicitServiceApproved
      ? explicitTarget.serviceUrl
      : undefined
    : input.launchUrl;
  const expectedServiceInstanceId =
    explicitTarget?.serviceInstanceId ??
    connection?.serviceInstanceId ??
    (sameService(input.status?.localService?.serviceUrl, activeLaunchUrl)
      ? input.status?.localService?.serviceInstanceId
      : sameService(input.status?.remoteService?.serviceUrl, activeLaunchUrl)
        ? input.status?.remoteService?.serviceInstanceId
        : undefined);
  const desiredTarget =
    explicitTarget ??
    (connection
      ? {
          serviceUrl: connection.serviceUrl,
          serviceInstanceId: connection.serviceInstanceId,
          collectiveId: connection.collectiveId,
        }
      : undefined);
  const { directory, failure, frameGeneration, selectWorld } = useCollectiveWorldDirectory({
    iframeRef: input.iframeRef,
    serviceUrl: activeLaunchUrl,
    expectedServiceInstanceId,
  });
  const resolution = useMemo(
    () => (desiredTarget && directory ? resolveExplicitWorldTarget(directory, desiredTarget) : undefined),
    [desiredTarget, directory],
  );
  const storedDirectory = useSyncExternalStore(
    subscribeWorldDirectoryStore,
    getWorldDirectoryStoreSnapshot,
    getWorldDirectoryStoreSnapshot,
  );
  const displayName = useMemo(() => {
    if (!explicitTarget) return undefined;
    return storedDirectory.services
      .find(
        (service) =>
          sameService(service.serviceUrl, explicitTarget.serviceUrl) &&
          service.serviceInstanceId === explicitTarget.serviceInstanceId,
      )
      ?.memberships.find((membership) => membership.collectiveId === explicitTarget.collectiveId)?.name;
  }, [explicitTarget, storedDirectory]);

  useEffect(() => {
    if (
      resolution?.kind !== 'selected' ||
      directory?.state !== 'ready' ||
      directory.currentCollectiveId === resolution.membership.collectiveId
    ) {
      return;
    }
    selectWorld(resolution.membership.collectiveId);
  }, [directory, resolution, selectWorld]);

  const frameUrl = useMemo(() => {
    return worldFrameUrl(activeLaunchUrl);
  }, [activeLaunchUrl]);
  const currentRemote = sameService(input.status?.remoteService?.serviceUrl, activeLaunchUrl)
    ? input.status?.remoteService
    : undefined;
  const remoteOffline = currentRemote?.state === 'offline';

  return {
    activeLaunchUrl,
    connection,
    sessionRequired: resolution?.kind === 'directory_unavailable' && resolution.state === 'session_required',
    error: remoteOffline
      ? '暂时连不上这个共同体的服务。'
      : currentRemote?.state === 'instance_mismatch'
        ? '这个入口通往另一个共同体 Service；原连接没有被替换，请检查 SSH 转发目标。'
        : worldTargetError({
            parsedTarget: input.parsedTarget,
            serviceApproved: explicitServiceApproved,
            directoryFailure: failure,
            resolution,
          }),
    explicitTarget,
    displayName,
    frameKey: activeLaunchUrl ? normalizeCollectiveServiceUrl(activeLaunchUrl) : undefined,
    frameGeneration,
    frameUrl,
    hasExplicitIntent,
    retryable:
      remoteOffline ||
      (input.parsedTarget.kind === 'target' &&
        resolution?.kind === 'directory_unavailable' &&
        resolution.state === 'unavailable' &&
        !failure),
  };
}

function resolveWorldConnection(
  status: CollectiveConnectorStatus | undefined,
  parsedTarget: ParsedCollectiveWorldTarget,
  selectedConnectionId?: string,
  launchUrl?: string,
): CollectiveConnectionProjection | undefined {
  if (!status) return undefined;
  if (parsedTarget.kind === 'invalid') return undefined;
  if (parsedTarget.kind === 'none')
    return preferredConnection(
      launchUrl ? status.connections.filter((item) => sameService(item.serviceUrl, launchUrl)) : status.connections,
      selectedConnectionId,
    );
  return status.connections.find(
    (candidate) =>
      candidate.authorityStatus !== 'revoked' &&
      sameService(candidate.serviceUrl, parsedTarget.target.serviceUrl) &&
      candidate.serviceInstanceId === parsedTarget.target.serviceInstanceId &&
      candidate.collectiveId === parsedTarget.target.collectiveId,
  );
}

function serviceIsKnown(
  status: CollectiveConnectorStatus | undefined,
  target: Extract<ParsedCollectiveWorldTarget, { kind: 'target' }>['target'] | undefined,
): boolean {
  if (!status || !target) return false;
  const knownConnection = status.connections.some(
    (candidate) =>
      sameService(candidate.serviceUrl, target.serviceUrl) && candidate.serviceInstanceId === target.serviceInstanceId,
  );
  const knownLocalService =
    sameService(status.localService?.serviceUrl, target.serviceUrl) &&
    status.localService?.serviceInstanceId === target.serviceInstanceId;
  const knownRemoteService =
    sameService(status.remoteService?.serviceUrl, target.serviceUrl) &&
    status.remoteService?.serviceInstanceId === target.serviceInstanceId;
  return knownConnection || knownLocalService || knownRemoteService;
}

function worldFrameUrl(activeLaunchUrl: string | undefined): string | undefined {
  if (!activeLaunchUrl || typeof window === 'undefined') return undefined;
  return canonicalClientUrl(activeLaunchUrl, window.location.origin);
}

function sameService(left?: string, right?: string): boolean {
  return Boolean(left && right && normalizeCollectiveServiceUrl(left) === normalizeCollectiveServiceUrl(right));
}

function worldTargetError(input: {
  readonly parsedTarget: ParsedCollectiveWorldTarget;
  readonly serviceApproved: boolean;
  readonly directoryFailure: 'service_mismatch' | undefined;
  readonly resolution: ReturnType<typeof resolveExplicitWorldTarget> | undefined;
}): string | undefined {
  if (input.parsedTarget.kind === 'invalid') {
    return '这个共同体的入口不完整；请从世界栏重新进入。';
  }
  if (input.directoryFailure === 'service_mismatch') {
    return '现在进不去这个共同体；它的服务已经变化，请从世界栏重新进入。';
  }
  if (input.parsedTarget.kind !== 'target') return undefined;
  if (!input.serviceApproved) {
    return '暂时连不上这个共同体的服务；请先在设置与管理里确认连接。';
  }
  if (!input.resolution || input.resolution.kind === 'selected') return undefined;
  if (input.resolution.kind === 'missing_membership') {
    return '当前账号现在进不去这个共同体；不会自动切换到别处。';
  }
  if (input.resolution.kind === 'service_mismatch') {
    return '现在进不去这个共同体；它的服务已经变化，请从世界栏重新进入。';
  }
  return input.resolution.state === 'session_required'
    ? '当前账号现在进不去这个共同体；请换账号或重新登录。不会自动切换到别处。'
    : '暂时连不上这个共同体的服务；不会自动切换到别处。';
}
