import type { BallCustodyEvent, CrossThreadCoordination } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

export interface A2ADispatchHandoffSource {
  readonly sourceMessageId: string;
  readonly fromCatId: string;
  readonly handoffSourceEventId: string;
}

export type A2ADispatchReplacement =
  | {
      readonly kind: 'handed';
      readonly sourceEventId: string;
      readonly sourceMessageId: string;
      readonly fromCatId?: string;
      readonly toCatId: string;
      readonly coordination?: CrossThreadCoordination;
    }
  | {
      readonly kind: 'handed_cvo';
      readonly sourceEventId: string;
      readonly sourceMessageId: string;
      readonly fromCatId: string;
      readonly intent: 'handoff' | 'done_notify' | 'fyi';
      readonly coordination?: CrossThreadCoordination;
    };

export type A2ADispatchHandoffInspection = A2ADispatchHandoffSource &
  ({ readonly outcome: 'live' } | { readonly outcome: 'replaced'; readonly replacement: A2ADispatchReplacement });

type HandedReplacementEvent = Omit<BallCustodyEvent, 'kind' | 'payload'> & {
  readonly kind: 'ball.handed';
  readonly payload: { readonly fromCatId?: string; readonly toCatId: string };
};

type HandedCvoReplacementEvent = Omit<BallCustodyEvent, 'kind' | 'payload'> & {
  readonly kind: 'ball.handed_cvo';
  readonly payload: {
    readonly fromCatId: string;
    readonly intent: 'handoff' | 'done_notify' | 'fyi';
  };
};

type ReplacementEvent = HandedReplacementEvent | HandedCvoReplacementEvent;

export async function resolveA2ADispatchHandoff(input: {
  readonly threadId: string;
  readonly catId: string;
  readonly source: A2ADispatchHandoffSource;
  readonly events: readonly BallCustodyEvent[];
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly log?: { warn(obj: unknown, msg?: string): void };
}): Promise<A2ADispatchHandoffInspection | { readonly outcome: 'missing' }> {
  const exactHandoffIndex = input.events.findIndex(
    (event) =>
      event.kind === 'ball.handed' &&
      event.sourceEventId === input.source.handoffSourceEventId &&
      event.payload.fromCatId === input.source.fromCatId &&
      event.payload.toCatId === input.catId,
  );
  if (exactHandoffIndex === -1) return { outcome: 'missing' };

  const lineageMessageIds = new Set([input.source.sourceMessageId]);
  const lineageCoordinations: CrossThreadCoordination[] = [];
  await seedSourceCoordination(input, lineageCoordinations);

  // Walk forward so a later successor may prove a transitive chain through an
  // earlier verified successor. Cat participation alone is never lineage.
  let replacement: A2ADispatchReplacement | undefined;
  for (let index = exactHandoffIndex + 1; index < input.events.length; index += 1) {
    const candidate = input.events[index];
    if (!candidate || !isReplacementEvent(candidate, input.catId)) continue;
    const candidateMessageId = replacementSourceMessageId(candidate);
    if (!candidateMessageId) continue;
    const candidateMessage = await readLineageMessage(
      input.messageStore,
      candidateMessageId,
      input.threadId,
      input.log,
    );
    if (!isVerifiedReplacementMessage(candidateMessage, input.threadId, candidate)) continue;
    if (!hasCausalLineage(candidateMessage, lineageMessageIds, lineageCoordinations)) continue;

    replacement = describeReplacement(candidate, candidateMessage);
    lineageMessageIds.add(candidateMessage.id);
    if (candidateMessage.extra?.coordination) lineageCoordinations.push(candidateMessage.extra.coordination);
  }
  if (!replacement) return { outcome: 'live', ...input.source };
  return { outcome: 'replaced', ...input.source, replacement };
}

async function seedSourceCoordination(
  input: {
    readonly threadId: string;
    readonly source: A2ADispatchHandoffSource;
    readonly messageStore: Pick<IMessageStore, 'getById'>;
    readonly log?: { warn(obj: unknown, msg?: string): void };
  },
  lineageCoordinations: CrossThreadCoordination[],
): Promise<void> {
  const sourceMessage = await readLineageMessage(
    input.messageStore,
    input.source.sourceMessageId,
    input.threadId,
    input.log,
  );
  if (sourceMessage?.threadId === input.threadId && sourceMessage.extra?.coordination) {
    lineageCoordinations.push(sourceMessage.extra.coordination);
  }
}

function isReplacementEvent(event: BallCustodyEvent, catId: string): event is ReplacementEvent {
  if (event.kind === 'ball.handed') {
    const fromCatId = event.payload.fromCatId;
    const toCatId = event.payload.toCatId;
    return (
      (fromCatId === undefined || typeof fromCatId === 'string') &&
      typeof toCatId === 'string' &&
      (fromCatId === catId || toCatId === catId)
    );
  }
  return (
    event.kind === 'ball.handed_cvo' &&
    typeof event.payload.fromCatId === 'string' &&
    event.payload.fromCatId === catId &&
    (event.payload.intent === 'handoff' || event.payload.intent === 'done_notify' || event.payload.intent === 'fyi')
  );
}

function describeReplacement(event: ReplacementEvent, message: StoredMessage): A2ADispatchReplacement {
  if (event.kind === 'ball.handed') {
    return {
      kind: 'handed',
      sourceEventId: event.sourceEventId,
      sourceMessageId: message.id,
      ...(event.payload.fromCatId ? { fromCatId: event.payload.fromCatId } : {}),
      toCatId: event.payload.toCatId,
      ...(message.extra?.coordination ? { coordination: { ...message.extra.coordination } } : {}),
    };
  }
  return {
    kind: 'handed_cvo',
    sourceEventId: event.sourceEventId,
    sourceMessageId: message.id,
    fromCatId: event.payload.fromCatId,
    intent: event.payload.intent,
    ...(message.extra?.coordination ? { coordination: { ...message.extra.coordination } } : {}),
  };
}

async function readLineageMessage(
  messageStore: Pick<IMessageStore, 'getById'>,
  sourceMessageId: string,
  threadId: string,
  log?: { warn(obj: unknown, msg?: string): void },
): Promise<StoredMessage | null> {
  try {
    return await messageStore.getById(sourceMessageId);
  } catch (err) {
    log?.warn(
      { err, threadId, sourceMessageId },
      '[F167] replacement lineage metadata unavailable; keeping the dispatch live unless another candidate proves lineage',
    );
    return null;
  }
}

function replacementSourceMessageId(event: ReplacementEvent): string | null {
  if (event.kind === 'ball.handed') return handedSourceMessageId(event);
  return event.sourceEventId.startsWith('route:') ? event.sourceEventId.slice('route:'.length) || null : null;
}

function handedSourceMessageId(event: HandedReplacementEvent): string | null {
  const prefix = 'route:';
  const suffix = `:${event.payload.toCatId}`;
  if (!event.sourceEventId.startsWith(prefix) || !event.sourceEventId.endsWith(suffix)) return null;
  const messageId = event.sourceEventId.slice(prefix.length, -suffix.length);
  return messageId || null;
}

function isVerifiedReplacementMessage(
  message: StoredMessage | null,
  threadId: string,
  event: ReplacementEvent,
): message is StoredMessage {
  if (!message || message.threadId !== threadId) return false;
  if (event.kind === 'ball.handed_cvo') return message.catId === event.payload.fromCatId;
  return Boolean(
    (!event.payload.fromCatId || message.catId === event.payload.fromCatId) &&
      (message.mentions.some((candidate) => candidate === event.payload.toCatId) ||
        message.extra?.targetCats?.includes(event.payload.toCatId)),
  );
}

function hasCausalLineage(
  message: StoredMessage,
  lineageMessageIds: ReadonlySet<string>,
  lineageCoordinations: readonly CrossThreadCoordination[],
): boolean {
  if (message.replyTo && lineageMessageIds.has(message.replyTo)) return true;
  const causalSource = message.extra?.causal?.triggerMessageId;
  if (causalSource && lineageMessageIds.has(causalSource)) return true;
  const coordination = message.extra?.coordination;
  return Boolean(
    coordination &&
      lineageCoordinations.some(
        (candidate) => candidate.id === coordination.id && candidate.subjectRef === coordination.subjectRef,
      ),
  );
}
