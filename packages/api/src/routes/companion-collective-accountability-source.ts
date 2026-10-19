import { isDeepStrictEqual } from 'node:util';
import { type CollectiveConnector, ConnectorTransportError } from '@cat-cafe/collective-connector';
import type { CollectiveAccountabilityAttentionItem, UnifiedAttentionSourceRead } from '@cat-cafe/shared';

const COVERAGE = 'pending_f290_collective_accountability_requests' as const;
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_CONNECTION = 10_000;

export interface CollectiveAccountabilityAttentionSourceRead {
  readonly items: CollectiveAccountabilityAttentionItem[];
  readonly state: UnifiedAttentionSourceRead;
  readonly reasons: string[];
}

interface ConnectionRead {
  readonly items: CollectiveAccountabilityAttentionItem[];
  readonly failed: false;
}

interface ConnectionFailure {
  readonly items: [];
  readonly failed: true;
  readonly status: UnifiedAttentionSourceRead['status'];
  readonly reason: string;
}

type ConnectionResult = ConnectionRead | ConnectionFailure;

/** Reads each owner-routed connection independently; one failure can never become an empty-complete mailbox. */
export async function readCollectiveAccountabilityAttentionSource(
  connector: CollectiveConnector | undefined,
  ownerUserId: string,
): Promise<CollectiveAccountabilityAttentionSourceRead> {
  const startedAt = Date.now();
  const base = { coverage: COVERAGE, startedAt };
  if (!connector) {
    return {
      items: [],
      reasons: ['collective_accountability_connector_unavailable'],
      state: { ...base, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' },
    };
  }
  let connections: Awaited<ReturnType<CollectiveConnector['listConnections']>>;
  try {
    connections = await connector.listConnections();
  } catch {
    return {
      items: [],
      reasons: ['collective_accountability_connection_index_unavailable'],
      state: { ...base, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' },
    };
  }
  const owned: typeof connections = [];
  const discoveryReasons: string[] = [];
  for (const connection of [...connections].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId),
  )) {
    try {
      const route = await connector.getHostRoute(connection.connectionId);
      if (route?.localOwnerUserId === ownerUserId) owned.push(connection);
    } catch {
      discoveryReasons.push('collective_accountability_route_read_failed');
    }
  }
  const results = await Promise.all(
    owned.map(async (connection): Promise<ConnectionResult> => {
      if (connection.authorityStatus !== 'connected' || !connection.authorizedHumanId) {
        return {
          items: [],
          failed: true,
          status: 'unauthenticated',
          reason: 'collective_accountability_connection_authority_unavailable',
        };
      }
      return readOwnedConnection(connector, ownerUserId, connection).catch((error: unknown) => ({
        items: [],
        failed: true,
        status: sourceStatus(error),
        reason:
          error instanceof AccountabilityAuthorityChanged
            ? 'collective_accountability_authority_changed'
            : 'collective_accountability_connection_read_failed',
      }));
    }),
  );
  const failed = results.filter((result): result is ConnectionFailure => result.failed);
  const successful = results.filter((result): result is ConnectionRead => !result.failed);
  const deduplicated = deduplicateItems(successful.flatMap((result) => result.items));
  const reasons = [
    ...new Set([...discoveryReasons, ...failed.map((result) => result.reason), ...deduplicated.reasons]),
  ];
  const incomplete = reasons.length > 0;
  const status =
    successful.length > 0 || (owned.length === 0 && discoveryReasons.length === 0)
      ? 'available'
      : combinedFailureStatus(failed);
  return {
    items: deduplicated.items,
    reasons,
    state: {
      ...base,
      observedAt: Date.now(),
      status,
      exhaustiveness: incomplete ? 'partial' : 'complete',
    },
  };
}

async function readOwnedConnection(
  connector: CollectiveConnector,
  ownerUserId: string,
  expected: Awaited<ReturnType<CollectiveConnector['getProjection']>>,
): Promise<ConnectionRead> {
  const beforeRoute = await connector.getHostRoute(expected.connectionId);
  if (beforeRoute?.localOwnerUserId !== ownerUserId || beforeRoute.revision !== expected.route.revision) {
    throw new AccountabilityAuthorityChanged();
  }
  const items: CollectiveAccountabilityAttentionItem[] = [];
  let offset = 0;
  let snapshot: string | undefined;
  let totalCount: number | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_CONNECTION; pageIndex += 1) {
    const page = await connector.readPendingAccountabilityRequests(expected.connectionId, ownerUserId, {
      offset,
      limit: PAGE_LIMIT,
      ...(snapshot ? { snapshot } : {}),
    });
    if (
      page.identity.serviceInstanceId !== expected.serviceInstanceId ||
      page.identity.collectiveId !== expected.collectiveId ||
      page.identity.connectionId !== expected.connectionId ||
      page.identity.authorizedHumanId !== expected.authorizedHumanId ||
      page.page.offset !== offset ||
      page.page.limit !== PAGE_LIMIT ||
      (snapshot !== undefined && page.page.snapshot !== snapshot) ||
      (totalCount !== undefined && page.page.totalCount !== totalCount)
    ) {
      throw new AccountabilityAuthorityChanged();
    }
    snapshot = page.page.snapshot;
    totalCount = page.page.totalCount;
    items.push(...page.items);
    if (!page.page.hasMore) break;
    if (page.items.length === 0) throw new Error('Collective accountability pagination made no progress');
    offset += page.items.length;
    if (pageIndex === MAX_PAGES_PER_CONNECTION - 1) {
      throw new Error('Collective accountability pagination exceeded its bounded source window');
    }
  }
  const [after, afterRoute] = await Promise.all([
    connector.getProjection(expected.connectionId),
    connector.getHostRoute(expected.connectionId),
  ]);
  if (
    after.authorityStatus !== 'connected' ||
    after.serviceInstanceId !== expected.serviceInstanceId ||
    after.collectiveId !== expected.collectiveId ||
    after.connectionId !== expected.connectionId ||
    after.authorizedHumanId !== expected.authorizedHumanId ||
    after.route.revision !== expected.route.revision ||
    afterRoute?.localOwnerUserId !== ownerUserId ||
    afterRoute.revision !== beforeRoute.revision
  ) {
    throw new AccountabilityAuthorityChanged();
  }
  return { items, failed: false };
}

function deduplicateItems(items: CollectiveAccountabilityAttentionItem[]) {
  const selected = new Map<string, CollectiveAccountabilityAttentionItem>();
  const semantic = new Map<string, unknown>();
  const conflicts = new Set<string>();
  for (const item of items) {
    const key = item.subjectRef;
    const value = semanticItem(item);
    const previous = semantic.get(key);
    if (previous && !isDeepStrictEqual(previous, value)) {
      conflicts.add(key);
      selected.delete(key);
      continue;
    }
    if (conflicts.has(key)) continue;
    semantic.set(key, value);
    const current = selected.get(key);
    if (!current || item.connectionId.localeCompare(current.connectionId) < 0) selected.set(key, item);
  }
  return {
    items: [...selected.values()].sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) || left.subjectRef.localeCompare(right.subjectRef),
    ),
    reasons: conflicts.size > 0 ? ['collective_accountability_identity_conflict'] : [],
  };
}

function semanticItem(item: CollectiveAccountabilityAttentionItem) {
  const { connectionId: _connectionId, actionRef: _actionRef, ...semantic } = item;
  return semantic;
}

function sourceStatus(error: unknown): UnifiedAttentionSourceRead['status'] {
  if (error instanceof ConnectorTransportError && error.statusCode === 401) return 'unauthenticated';
  if (error instanceof ConnectorTransportError && error.statusCode === 403) return 'forbidden';
  if (error && typeof error === 'object' && Reflect.get(error, 'name') === 'ZodError') return 'invalid';
  return 'unavailable';
}

function combinedFailureStatus(failures: ConnectionFailure[]): UnifiedAttentionSourceRead['status'] {
  const statuses = new Set(failures.map((failure) => failure.status));
  return statuses.size === 1 ? (failures[0]?.status ?? 'unavailable') : 'unavailable';
}

class AccountabilityAuthorityChanged extends Error {}
