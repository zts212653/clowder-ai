import { isDeepStrictEqual } from 'node:util';
import type { CollectiveWorkResultFile, CollectiveWorkResultTextSource } from '@cat-cafe/shared';
import type { AssignedWorkAuthorityScope } from './connector.js';
import { participationError } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { CollectiveServiceClient } from './service-client.js';
import type { ConnectorConnectionState, HostRouteConfig, WorkResultArtifactSnapshot } from './state.js';
import {
  type CollectiveWorkResultPublication,
  prepareWorkResultFilePublication,
  projectWorkResultPublications,
} from './work-result-publication.js';

export interface AcceptedWorkResultFileSeal {
  readonly artifactSnapshot: WorkResultArtifactSnapshot;
  readonly source: CollectiveWorkResultTextSource;
}

export async function reconcileAcceptedWorkResultFiles(input: {
  readonly connectionId: string;
  readonly persistence: ConnectorPersistence;
  readonly service: CollectiveServiceClient;
  readonly readScope: (workId: string) => Promise<AssignedWorkAuthorityScope>;
  readonly seal: (
    scope: AssignedWorkAuthorityScope,
    publication: CollectiveWorkResultPublication,
  ) => Promise<AcceptedWorkResultFileSeal | undefined>;
}): Promise<{ readonly published: number }> {
  const initial = input.persistence.snapshot();
  const connection = requireConnection(initial.connections[input.connectionId]);
  const candidates = unpublishedCandidates(connection, initial.hostRoutes[input.connectionId]);
  if (candidates.length === 0) return { published: 0 };
  await requireFileCapability(input.service, connection);
  let published = 0;
  for (const candidate of candidates) {
    if (await reconcileCandidate(input, candidate)) published += 1;
  }
  return { published };
}

function unpublishedCandidates(connection: ConnectorConnectionState, route?: HostRouteConfig) {
  return projectWorkResultPublications(connection, route).filter((publication) => {
    const item = connection.outbox.find((entry) => entry.acceptedEventId === publication.resultEventId);
    return Boolean(
      item?.workPurpose?.artifactSnapshot &&
        !item.workPurpose.resultFile &&
        item.body.includes(`](${item.workPurpose.artifactSnapshot.artifactRef})`),
    );
  });
}

async function requireFileCapability(service: CollectiveServiceClient, connection: ConnectorConnectionState) {
  const metadata = await service.readMetadata(connection.serviceUrl);
  if (metadata.serviceInstanceId !== connection.serviceInstanceId)
    throw participationError('RETURN_UNAVAILABLE', 'Collective Service identity changed before file recovery');
  if (metadata.capabilities?.workResultFiles !== 1)
    throw participationError(
      'RETURN_UNAVAILABLE',
      'Collective Service must support authenticated Work result files before recovery',
    );
}

async function reconcileCandidate(
  input: Parameters<typeof reconcileAcceptedWorkResultFiles>[0],
  candidate: CollectiveWorkResultPublication,
): Promise<boolean> {
  const scope = await input.readScope(candidate.workId);
  const publication = scope.resultPublications.find(
    (current) =>
      current.resultEventId === candidate.resultEventId &&
      current.resultRevision === candidate.resultRevision &&
      current.taskRef === candidate.taskRef,
  );
  if (!publication) return false;
  const sealed = await input.seal(scope, publication);
  if (!sealed) return false;
  const snapshot = input.persistence.snapshot();
  const connection = requireConnection(snapshot.connections[input.connectionId]);
  const item = acceptedResultOutboxItem(connection, publication.resultEventId);
  const prepared = prepareWorkResultFilePublication({
    outboxId: item.outboxId,
    serviceUrl: connection.serviceUrl,
    body: item.body,
    artifactSnapshot: sealed.artifactSnapshot,
    source: sealed.source,
  });
  if (!prepared.file)
    throw participationError('RETURN_UNAVAILABLE', 'Accepted result file could not be prepared from its sealed bytes');
  if (prepared.body === item.body)
    throw participationError('RETURN_UNAVAILABLE', 'Accepted result no longer contains its sealed Host file address');
  await bindAtService(input.service, connection, publication.resultEventId, prepared.file);
  await recordLocalBinding(input, publication.resultEventId, sealed.artifactSnapshot, prepared.file);
  return true;
}

async function bindAtService(
  service: CollectiveServiceClient,
  connection: ConnectorConnectionState,
  resultEventId: string,
  file: CollectiveWorkResultFile,
) {
  await service.bindAcceptedWorkResultFile(connection.serviceUrl, requireCredential(connection), {
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    resultEventId,
    workResultFile: file,
  });
}

async function recordLocalBinding(
  input: Parameters<typeof reconcileAcceptedWorkResultFiles>[0],
  resultEventId: string,
  artifactSnapshot: WorkResultArtifactSnapshot,
  file: CollectiveWorkResultFile,
) {
  await input.persistence.transaction((state) => {
    const current = acceptedResultOutboxItem(requireConnection(state.connections[input.connectionId]), resultEventId);
    if (current.workPurpose?.resultFile && !isDeepStrictEqual(current.workPurpose.resultFile, file))
      throw participationError('REPLY_PAYLOAD_CONFLICT', 'Accepted result already owns another public file');
    if (!current.workPurpose) throw participationError('RETURN_UNAVAILABLE', 'Accepted result lost its Work purpose');
    current.workPurpose.artifactSnapshot = artifactSnapshot;
    current.workPurpose.resultFile = file;
  });
}

function acceptedResultOutboxItem<Connection extends Pick<ConnectorConnectionState, 'outbox'>>(
  connection: Connection,
  resultEventId: string,
): Connection['outbox'][number] {
  const matches = connection.outbox.filter(
    (item) =>
      item.status === 'accepted' &&
      item.acceptedEventId === resultEventId &&
      item.workPurpose &&
      !item.workPurpose.progressKey,
  );
  if (matches.length !== 1)
    throw participationError('RETURN_UNAVAILABLE', 'Accepted result has no unique durable Host outbox item');
  const [item] = matches;
  if (!item) throw participationError('RETURN_UNAVAILABLE', 'Accepted result outbox item disappeared');
  return item;
}

function requireConnection<Connection extends ConnectorConnectionState>(
  connection: Connection | undefined,
): Connection {
  if (!connection) throw new Error('Collective connection was not found');
  return connection;
}

function requireCredential(connection: ConnectorConnectionState): string {
  if (connection.authorityStatus !== 'connected')
    throw participationError('PARTICIPATION_REVOKED', 'Collective endpoint authority is unavailable');
  if (!connection.endpointCredential)
    throw participationError('PARTICIPATION_REVOKED', 'Collective endpoint credential is unavailable');
  return connection.endpointCredential;
}
