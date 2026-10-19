import { createHash } from 'node:crypto';
import {
  type CollectiveWorkResultFile,
  type CollectiveWorkResultTextSource,
  collectiveWorkResultFilePath,
  collectiveWorkResultFileSchema,
  collectiveWorkResultMediaTypeForFileName,
  collectiveWorkResultTextSourceSchema,
} from '@cat-cafe/shared';
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

export function workResultBodyLinksTextSource(body: string, source: CollectiveWorkResultTextSource): boolean {
  const parsed = collectiveWorkResultTextSourceSchema.parse(source);
  return body.includes(`](${parsed.sourceHref})`);
}

export function prepareWorkResultFilePublication(input: {
  readonly outboxId: string;
  readonly serviceUrl: string;
  readonly body: string;
  readonly artifactSnapshot?: WorkResultArtifactSnapshot;
  readonly source?: CollectiveWorkResultTextSource;
}): { readonly body: string; readonly file?: CollectiveWorkResultFile } {
  const source = input.source ? collectiveWorkResultTextSourceSchema.parse(input.source) : undefined;
  const seal = input.artifactSnapshot?.textPublication;
  if (!source) {
    if (seal && input.body.includes(`](${input.artifactSnapshot?.artifactRef})`))
      throw new WorkResultFilePublicationError('A linked sealed text result requires its exact public bytes');
    return { body: input.body };
  }
  if (
    !seal ||
    source.sourceHref !== input.artifactSnapshot?.artifactRef ||
    source.sourceHref !== `/uploads/${source.fileName}` ||
    source.mediaType !== collectiveWorkResultMediaTypeForFileName(source.fileName) ||
    source.mediaType !== seal.mediaType ||
    source.contentDigest !== seal.contentDigest ||
    source.byteLength !== seal.byteLength
  )
    throw new WorkResultFilePublicationError('Work result file does not match the Host-sealed Artifact');
  const bytes = Buffer.from(source.contentBase64, 'base64');
  if (
    bytes.toString('base64') !== source.contentBase64 ||
    bytes.length !== source.byteLength ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== source.contentDigest
  )
    throw new WorkResultFilePublicationError('Work result file bytes do not match their sealed digest');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary text');
  } catch {
    throw new WorkResultFilePublicationError('Work result file is not supported UTF8 text');
  }
  const fileId = `wrf_${createHash('sha256')
    .update(JSON.stringify([input.outboxId, source.contentDigest, source.fileName]))
    .digest('hex')}`;
  const file = collectiveWorkResultFileSchema.parse({ ...source, fileId });
  const publicHref = new URL(collectiveWorkResultFilePath(file), input.serviceUrl).toString();
  const sourceLink = `](${source.sourceHref})`;
  if (!input.body.includes(sourceLink)) return { body: input.body };
  return { body: input.body.split(sourceLink).join(`](${publicHref})`), file };
}

export class WorkResultFilePublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkResultFilePublicationError';
  }
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
