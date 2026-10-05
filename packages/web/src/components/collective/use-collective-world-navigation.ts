'use client';

import { type RefObject, useEffect, useMemo } from 'react';
import {
  type CollectiveConnectionProjection,
  type CollectiveConnectorStatus,
  canonicalClientUrl,
  normalizeCollectiveServiceUrl,
} from './collective-client';
import { preferredConnection } from './collective-connection-selection';
import { type ParsedCollectiveWorldTarget, resolveExplicitWorldTarget } from './collective-world-directory';
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
  const connection = resolveWorldConnection(input.status, input.parsedTarget, input.selectedConnectionId);
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
      : undefined);
  const { directory, failure, frameGeneration, selectWorld } = useCollectiveWorldDirectory({
    iframeRef: input.iframeRef,
    serviceUrl: activeLaunchUrl,
    expectedServiceInstanceId,
  });
  const resolution = useMemo(
    () => (explicitTarget && directory ? resolveExplicitWorldTarget(directory, explicitTarget) : undefined),
    [directory, explicitTarget],
  );

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
    return worldFrameUrl(activeLaunchUrl, explicitTarget, connection);
  }, [activeLaunchUrl, connection, explicitTarget]);

  return {
    activeLaunchUrl,
    connection,
    error: worldTargetError({
      parsedTarget: input.parsedTarget,
      serviceApproved: explicitServiceApproved,
      directoryFailure: failure,
      resolution,
    }),
    explicitTarget,
    frameGeneration,
    frameUrl,
    hasExplicitIntent,
  };
}

function resolveWorldConnection(
  status: CollectiveConnectorStatus | undefined,
  parsedTarget: ParsedCollectiveWorldTarget,
  selectedConnectionId?: string,
): CollectiveConnectionProjection | undefined {
  if (!status) return undefined;
  if (parsedTarget.kind === 'invalid') return undefined;
  if (parsedTarget.kind === 'none') return preferredConnection(status.connections, selectedConnectionId);
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
  return knownConnection || knownLocalService;
}

function worldFrameUrl(
  activeLaunchUrl: string | undefined,
  explicitTarget: Extract<ParsedCollectiveWorldTarget, { kind: 'target' }>['target'] | undefined,
  connection: CollectiveConnectionProjection | undefined,
): string | undefined {
  if (!activeLaunchUrl || typeof window === 'undefined') return undefined;
  const url = new URL(canonicalClientUrl(activeLaunchUrl, window.location.origin));
  if (explicitTarget) url.searchParams.set('collectiveId', explicitTarget.collectiveId);
  else if (connection && sameService(connection.serviceUrl, url.origin)) {
    url.searchParams.set('collectiveId', connection.collectiveId);
  }
  return url.toString();
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
    return '目标共同家园地址不完整；请从已接入的世界目录重新选择。';
  }
  if (input.parsedTarget.kind !== 'target') return undefined;
  if (!input.serviceApproved) {
    return '目标共同家园所在的 Service 尚未接入；请先确认 Service 地址。';
  }
  if (input.directoryFailure === 'service_mismatch') {
    return '目标共同家园已不可用：Service 身份已经变化。';
  }
  if (!input.resolution || input.resolution.kind === 'selected') return undefined;
  if (input.resolution.kind === 'missing_membership') {
    return '目标共同家园已不可用：当前账号不再拥有该成员资格。';
  }
  if (input.resolution.kind === 'service_mismatch') {
    return '目标共同家园已不可用：Service 身份已经变化。';
  }
  return input.resolution.state === 'session_required'
    ? '目标共同家园需要重新登录；不会自动切换到其他共同家园。'
    : '目标共同家园所在的 Service 暂时不可达；不会自动切换到其他共同家园。';
}
