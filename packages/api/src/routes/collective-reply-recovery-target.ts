import { createHash } from 'node:crypto';
import { collectiveSourceIdentitySchema, readMessageOutputLayout } from '@cat-cafe/shared';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { readPluginMessageExtra } from '../domains/messaging/envelope.js';

const MAX_PUBLIC_REPLY_LENGTH = 20_000;

export type RecoveryCode =
  | 'COLLECTIVE_REPLY_RECOVERY_NOT_FOUND'
  | 'COLLECTIVE_REPLY_RECOVERY_SOURCE_INVALID'
  | 'COLLECTIVE_REPLY_RECOVERY_NOT_READY'
  | 'COLLECTIVE_REPLY_RECOVERY_OUTPUT_UNAVAILABLE'
  | 'COLLECTIVE_REPLY_RECOVERY_TARGET_UNAVAILABLE'
  | 'COLLECTIVE_REPLY_RECOVERY_UNAVAILABLE'
  | 'COLLECTIVE_REPLY_RECOVERY_QUEUE_FULL';

export class CollectiveReplyRecoveryError extends Error {
  constructor(
    readonly code: RecoveryCode,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'CollectiveReplyRecoveryError';
  }
}

export interface CollectiveReplyRecoveryTarget {
  readonly body: string;
  readonly bodySha256: string;
  readonly eventId: string;
  readonly responseMessageId: string;
}

export function recoveryDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hasUnavailableLifecycle(message: StoredMessage): boolean {
  if (message.deletedAt !== undefined) return true;
  if (message.recall !== undefined) return true;
  if (message._tombstone) return true;
  return message.deliveryStatus === 'canceled';
}

/**
 * Current plugin messages keep presentation under extra.pluginMessage while
 * legacy connector rows keep it in source. This identifies the public source;
 * owner, target, lifecycle and output authority are still checked below.
 */
function recoverySourcePresentation(message: StoredMessage) {
  const sender = message.from;
  if (sender?.kind === 'plugin') {
    const pluginMessage = readPluginMessageExtra(message);
    if (
      !pluginMessage ||
      pluginMessage.instanceId !== sender.instanceId ||
      pluginMessage.provenance.origin?.kind !== 'plugin' ||
      pluginMessage.provenance.origin.instanceId !== sender.instanceId
    )
      return undefined;
    return pluginMessage.presentation;
  }
  if (sender && sender.kind !== 'external') return undefined;
  if (sender?.kind === 'external' && sender.connectorId !== 'collective') return undefined;
  return message.source;
}

/**
 * Select only a completed, single-source, plain-text model final. The output
 * layout is the authority for excluding Host-owned suffixes such as the cat
 * signature; guessing from visible text would make recovery change the reply.
 */
export function readCollectiveReplyRecoveryTarget(
  source: StoredMessage,
  response: StoredMessage,
  ownerUserId: string,
  targetCatId: string,
): CollectiveReplyRecoveryTarget {
  const sourcePresentation = recoverySourcePresentation(source);
  const participation = collectiveSourceIdentitySchema.safeParse(sourcePresentation?.meta?.participation);
  if (
    sourcePresentation?.connector !== 'collective' ||
    source.userId !== ownerUserId ||
    source.catId !== null ||
    hasUnavailableLifecycle(source) ||
    !participation.success ||
    participation.data.catId !== targetCatId
  ) {
    throw new CollectiveReplyRecoveryError(
      'COLLECTIVE_REPLY_RECOVERY_SOURCE_INVALID',
      "This is not the current owner's exact Collective source.",
    );
  }
  const dispatches =
    source.lifecycle?.kind === 'input'
      ? (source.lifecycle.dispatchRefs?.filter((ref) => ref.targetId === targetCatId) ?? [])
      : [];
  const [dispatch] = dispatches;
  if (
    dispatches.length !== 1 ||
    dispatch?.phase !== 'settled' ||
    dispatch.statusMessageId !== response.id ||
    response.threadId !== source.threadId ||
    response.userId !== ownerUserId ||
    response.catId !== targetCatId ||
    hasUnavailableLifecycle(response) ||
    response.replyTo !== source.id ||
    response.lifecycle?.kind !== 'response' ||
    response.lifecycle.status !== 'completed' ||
    response.lifecycle.targetId !== targetCatId ||
    response.lifecycle.inputMessageIds.length !== 1 ||
    response.lifecycle.inputMessageIds[0] !== source.id
  ) {
    throw new CollectiveReplyRecoveryError(
      'COLLECTIVE_REPLY_RECOVERY_NOT_READY',
      'The original Cat turn has no exact completed reply to recover.',
    );
  }
  if (response.contentBlocks?.length) {
    throw new CollectiveReplyRecoveryError(
      'COLLECTIVE_REPLY_RECOVERY_OUTPUT_UNAVAILABLE',
      'Rich replies require their original publication path.',
    );
  }
  const layout = readMessageOutputLayout(response.extra?.outputLayout);
  if (
    !layout ||
    layout.status !== 'available' ||
    layout.owner.threadId !== source.threadId ||
    layout.owner.catId !== targetCatId ||
    layout.owner.turnInvocationId !== response.lifecycle.invocationId ||
    layout.contentRevision.length !== response.content.length ||
    layout.contentRevision.sha256 !== recoveryDigest(response.content)
  ) {
    throw new CollectiveReplyRecoveryError(
      'COLLECTIVE_REPLY_RECOVERY_OUTPUT_UNAVAILABLE',
      'The original reply output boundary is unavailable or stale.',
    );
  }
  const finals = layout.runs.filter((run) => run.channel === 'final');
  const [final] = finals;
  if (finals.length !== 1 || !final) {
    throw new CollectiveReplyRecoveryError(
      'COLLECTIVE_REPLY_RECOVERY_OUTPUT_UNAVAILABLE',
      'Only one proven plain-text final can be recovered.',
    );
  }
  const body = response.content.slice(final.start + final.gluePrefixLength, final.end);
  if (!body.trim() || body.length > MAX_PUBLIC_REPLY_LENGTH) {
    throw new CollectiveReplyRecoveryError(
      'COLLECTIVE_REPLY_RECOVERY_OUTPUT_UNAVAILABLE',
      'The proven public reply body is empty or exceeds the Collective limit.',
    );
  }
  return {
    body,
    bodySha256: recoveryDigest(body),
    eventId: participation.data.eventId,
    responseMessageId: response.id,
  };
}
