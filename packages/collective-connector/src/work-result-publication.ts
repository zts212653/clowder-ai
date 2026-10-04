import { z } from 'zod';
import type { ConnectorConnectionState, HostRouteConfig, WorkResultArtifactSnapshot } from './state.js';

const boundedOwnerRef = z.string().trim().min(1).max(1_000);

/** Host-sealed published UTF8 bytes; never a caller supplied workspace locator. */
export const workResultTextPublicationSchema = z
  .object({
    v: z.literal(1),
    taskId: boundedOwnerRef,
    resultRevision: z.number().int().positive(),
    executionRevision: z.number().int().positive(),
    executionRef: boundedOwnerRef.regex(/^message:.+/).optional(),
    sourceMessageId: boundedOwnerRef,
    sourceMessageRevision: boundedOwnerRef,
    triggerMessageId: boundedOwnerRef,
    publisherCatId: boundedOwnerRef,
    invocationId: boundedOwnerRef,
    item: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('rich-file'), blockId: boundedOwnerRef }).strict(),
      z.object({ kind: z.literal('content-block'), index: z.number().int().nonnegative() }).strict(),
    ]),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative().max(65_536),
    mediaType: z.enum(['text/markdown', 'text/plain']),
  })
  .strict();

export interface CollectiveWorkResultPublicationCandidate {
  readonly connectionId: string;
  readonly workId: string;
  readonly taskRef: string;
}

export interface CollectiveWorkResultPublication {
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly authorizedHumanId: string;
  readonly localOwnerUserId: string | undefined;
  readonly assignmentEventId: string;
  readonly channelId: string;
  readonly catId: string;
  readonly taskRef: string;
  readonly taskRevision: number;
  readonly workId: string;
  readonly resultEventId: string;
  readonly resultRevision: number;
  readonly executionRevision?: number;
  readonly artifactSnapshot?: WorkResultArtifactSnapshot;
}

export function projectWorkResultPublications(
  connection: ConnectorConnectionState,
  route?: HostRouteConfig,
  workId?: string,
): CollectiveWorkResultPublication[] {
  const authorizedHumanId = connection.authorizedHumanId;
  if (connection.authorityStatus !== 'connected' || !authorizedHumanId) return [];
  return connection.outbox.flatMap((item) => {
    const purpose = item.workPurpose;
    const source = item.replySource;
    if (
      item.status !== 'accepted' ||
      !item.acceptedEventId ||
      !purpose?.workId ||
      purpose.progressKey ||
      (workId !== undefined && purpose.workId !== workId) ||
      !source
    ) {
      return [];
    }
    return [
      {
        serviceInstanceId: connection.serviceInstanceId,
        collectiveId: connection.collectiveId,
        connectionId: connection.connectionId,
        authorizedHumanId,
        localOwnerUserId: route?.localOwnerUserId,
        assignmentEventId: purpose.assignmentEventId ?? source.eventId,
        channelId: source.location.channelId,
        catId: source.catId,
        taskRef: purpose.taskRef,
        taskRevision: purpose.admittedRevision,
        workId: purpose.workId,
        resultEventId: item.acceptedEventId,
        resultRevision: purpose.resultRevision,
        ...(purpose.executionRevision ? { executionRevision: purpose.executionRevision } : {}),
        ...(purpose.artifactSnapshot ? { artifactSnapshot: structuredClone(purpose.artifactSnapshot) } : {}),
      },
    ];
  });
}
