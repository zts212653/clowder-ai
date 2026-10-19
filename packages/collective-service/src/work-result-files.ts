import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveAgentMessageRequest,
  type CollectiveEventEnvelope,
  type CollectiveWorkResultFile,
  type CollectiveWorkResultReceipt,
  collectiveWorkResultFileIdSchema,
  collectiveWorkResultFilePath,
  collectiveWorkResultFileSchema,
  collectiveWorkResultMediaTypeForFileName,
} from '@cat-cafe/shared';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, resolveSession } from './identity-store.js';
import { requireMembership } from './membership-authority.js';
import type { MutableServiceState, ServiceState, WorkResultFileRecord } from './state.js';

export function persistCollectiveWorkResultFile(input: {
  readonly state: MutableServiceState;
  readonly request: CollectiveAgentMessageRequest;
  readonly receipt?: CollectiveWorkResultReceipt;
  readonly event: CollectiveEventEnvelope;
  readonly serviceOrigin: string;
  readonly replayed: boolean;
}): void {
  const file = input.request.workResultFile;
  const existing = Object.values(input.state.workResultFiles).find(
    (candidate) => candidate.resultEventId === input.event.eventId,
  );
  if (!file) {
    if (existing) conflict();
    return;
  }
  if (!input.receipt) invalid('A public result file requires current Work result authority');
  const parsed = collectiveWorkResultFileSchema.parse(file);
  verifyResultFileBytes(parsed, invalid);
  assertPublishedBodyAddress(input.request.body, parsed, input.serviceOrigin);
  const record = resultFileRecord(input.event, input.receipt, parsed);
  if (input.replayed) {
    if (!existing) conflict();
    if (!isDeepStrictEqual(existing, record)) conflict();
    return;
  }
  persistResultFileRecord(input.state, record, false);
}

/** Adds immutable file bytes to an exact legacy result event without replaying or revising the event itself. */
export function bindAcceptedCollectiveWorkResultFile(input: {
  readonly state: MutableServiceState;
  readonly event: CollectiveEventEnvelope;
  readonly file: CollectiveWorkResultFile;
}): WorkResultFileRecord {
  const { event } = input;
  const receipt = event.workResultReceipt;
  const work = receipt ? input.state.works[receipt.workId] : undefined;
  const assignment = work?.assignment;
  if (
    !receipt ||
    event.actor.kind !== 'agent' ||
    !event.replyToEventId ||
    !event.location ||
    !work ||
    !assignment ||
    work.collectiveId !== event.collectiveId ||
    work.resultEventId !== event.eventId ||
    (work.resultRevision ?? 1) !== receipt.resultRevision ||
    work.assignmentEventId !== receipt.assignmentEventId ||
    work.sourceLocation.channelId !== event.location.channelId ||
    assignment.connectionId !== receipt.connectionId ||
    assignment.humanId !== receipt.humanId ||
    assignment.catId !== (receipt.assignmentCatId ?? receipt.catId) ||
    !['result_ready', 'completed'].includes(work.lifecycle) ||
    event.replyToEventId !== receipt.assignmentEventId ||
    event.actor.provenance.connectionId !== receipt.connectionId ||
    event.actor.provenance.catId !== receipt.catId ||
    event.actor.human.humanId !== receipt.humanId
  )
    invalid('Legacy file binding does not name one accepted current Work result');
  const parsed = collectiveWorkResultFileSchema.parse(input.file);
  verifyResultFileBytes(parsed, invalid);
  if (!event.body.includes(`](${parsed.sourceHref})`))
    invalid('Legacy Work result body does not contain the exact Host file address');
  const record = resultFileRecord(event, receipt, parsed);
  persistResultFileRecord(input.state, record, true);
  return structuredClone(record);
}

/** Human reads project legacy Host-relative destinations through authenticated Service sidecars in one bounded pass. */
export function projectCollectiveWorkResultEvents(
  state: ServiceState,
  events: readonly CollectiveEventEnvelope[],
  serviceOrigin: string,
): CollectiveEventEnvelope[] {
  const filesByEvent = new Map<string, WorkResultFileRecord>();
  for (const record of Object.values(state.workResultFiles)) {
    if (filesByEvent.has(record.resultEventId)) corrupt('Work result event owns more than one file record');
    filesByEvent.set(record.resultEventId, record);
  }
  const origin = new URL(serviceOrigin).origin;
  return events.map((event) => {
    const record = filesByEvent.get(event.eventId);
    if (!record) return structuredClone(event);
    const sourceLink = `](${record.sourceHref})`;
    if (!event.body.includes(sourceLink)) return structuredClone(event);
    const publicHref = new URL(collectiveWorkResultFilePath(record), origin).toString();
    return { ...structuredClone(event), body: event.body.split(sourceLink).join(`](${publicHref})`) };
  });
}

export function readCollectiveWorkResultFile(
  state: ServiceState,
  sessionToken: string,
  fileId: string,
  fileName: string,
): { readonly record: WorkResultFileRecord; readonly bytes: Buffer } {
  const canonicalId = collectiveWorkResultFileIdSchema.parse(fileId);
  const record = state.workResultFiles[canonicalId];
  if (!record) notFound();
  if (record.fileName !== fileName) notFound();
  const auth = resolveSession(state, sessionToken);
  requireHumanAuthBinding(state, auth.human.humanId);
  requireMembership(state, record.collectiveId, auth.human.humanId);
  const bytes = verifyResultFileBytes(record, corrupt);
  return { record: structuredClone(record), bytes };
}

function verifyResultFileBytes(
  file: Pick<CollectiveWorkResultFile, 'byteLength' | 'contentBase64' | 'contentDigest' | 'fileName' | 'mediaType'>,
  reject: (message: string) => never,
): Buffer {
  const bytes = Buffer.from(file.contentBase64, 'base64');
  if (
    bytes.toString('base64') !== file.contentBase64 ||
    bytes.length !== file.byteLength ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== file.contentDigest
  )
    reject('Work result file bytes do not match their declared digest');
  if (file.mediaType !== collectiveWorkResultMediaTypeForFileName(file.fileName))
    reject('Work result file name and media type do not match');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary text');
  } catch {
    reject('Work result file is not supported UTF8 text');
  }
  return bytes;
}

function resultFileRecord(
  event: CollectiveEventEnvelope,
  receipt: CollectiveWorkResultReceipt,
  file: CollectiveWorkResultFile,
): WorkResultFileRecord {
  return {
    ...file,
    collectiveId: event.collectiveId,
    workId: receipt.workId,
    resultEventId: event.eventId,
    resultRevision: receipt.resultRevision,
    assignmentEventId: receipt.assignmentEventId,
    connectionId: receipt.connectionId,
    humanId: receipt.humanId,
    catId: receipt.catId,
    createdAt: event.acceptedAt,
  };
}

function persistResultFileRecord(
  state: MutableServiceState,
  record: WorkResultFileRecord,
  exactReplayAllowed: boolean,
): void {
  const existing = Object.values(state.workResultFiles).find(
    (candidate) => candidate.resultEventId === record.resultEventId,
  );
  const sameId = state.workResultFiles[record.fileId];
  if (existing || sameId) {
    if (exactReplayAllowed && existing === sameId && isDeepStrictEqual(existing, record)) return;
    conflict();
  }
  state.workResultFiles[record.fileId] = record;
}

function assertPublishedBodyAddress(body: string, file: CollectiveWorkResultFile, serviceOrigin: string): void {
  const publicHref = new URL(collectiveWorkResultFilePath(file), new URL(serviceOrigin).origin).toString();
  if (!body.includes(`](${publicHref})`))
    invalid('Work result body does not use its authenticated Service file address');
  if (body.includes(`](${file.sourceHref})`)) invalid('Work result body still exposes its private Host file address');
}

function invalid(message: string): never {
  throw new CollectiveServiceError('WORK_RESULT_FILE_INVALID', message, 409);
}

function corrupt(message: string): never {
  throw new CollectiveServiceError('STATE_CORRUPT', `Stored ${message.toLowerCase()}`, 500);
}

function notFound(): never {
  throw new CollectiveServiceError('WORK_RESULT_FILE_NOT_FOUND', 'Work result file was not found', 404);
}

function conflict(): never {
  throw new CollectiveServiceError(
    'CLIENT_EVENT_CONFLICT',
    'clientEventId already names another Work result file',
    409,
  );
}
