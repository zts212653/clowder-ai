import type { BallCustodyEvent, CrossThreadCoordination } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

export interface A2ADispatchHandoffSource {
  readonly sourceMessageId: string;
  readonly fromCatId: string;
  readonly handoffSourceEventId: string;
}

export type A2ADispatchReplacement =
  | {
      readonly kind: 'held';
      readonly sourceEventId: string;
      readonly holderCatId: string;
      readonly fireAt: number;
    }
  | {
      readonly kind: 'handed';
      readonly sourceEventId: string;
      readonly sourceMessageId?: string;
      readonly fromCatId?: string;
      readonly toCatId: string;
      readonly coordination?: CrossThreadCoordination;
    }
  | {
      readonly kind: 'handed_cvo';
      readonly sourceEventId: string;
      readonly sourceMessageId?: string;
      readonly fromCatId: string;
      readonly intent: 'handoff' | 'done_notify' | 'fyi';
      readonly coordination?: CrossThreadCoordination;
    };

export type A2ADispatchHandoffInspection = A2ADispatchHandoffSource &
  ({ readonly outcome: 'live' } | { readonly outcome: 'replaced'; readonly replacement: A2ADispatchReplacement });

type HeldReplacementEvent = Omit<BallCustodyEvent, 'kind' | 'payload'> & {
  readonly kind: 'ball.held';
  readonly payload: { readonly catId: string; readonly fireAt: number };
};

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

type ReplacementEvent = HeldReplacementEvent | HandedReplacementEvent | HandedCvoReplacementEvent;

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

  let replacementEvent: ReplacementEvent | undefined;
  for (let index = input.events.length - 1; index > exactHandoffIndex; index -= 1) {
    const candidate = input.events[index];
    if (candidate && isReplacementEvent(candidate, input.catId)) {
      replacementEvent = candidate;
      break;
    }
  }
  if (!replacementEvent) return { outcome: 'live', ...input.source };
  return {
    outcome: 'replaced',
    ...input.source,
    replacement: await describeReplacement(input.threadId, replacementEvent, input.messageStore, input.log),
  };
}

function isReplacementEvent(event: BallCustodyEvent, catId: string): event is ReplacementEvent {
  if (event.kind === 'ball.held') {
    return (
      typeof event.payload.catId === 'string' &&
      event.payload.catId === catId &&
      typeof event.payload.fireAt === 'number' &&
      Number.isFinite(event.payload.fireAt)
    );
  }
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

async function describeReplacement(
  threadId: string,
  event: ReplacementEvent,
  messageStore: Pick<IMessageStore, 'getById'>,
  log?: { warn(obj: unknown, msg?: string): void },
): Promise<A2ADispatchReplacement> {
  if (event.kind === 'ball.held') {
    return {
      kind: 'held',
      sourceEventId: event.sourceEventId,
      holderCatId: event.payload.catId,
      fireAt: event.payload.fireAt,
    };
  }
  if (event.kind === 'ball.handed') {
    const base = {
      kind: 'handed' as const,
      sourceEventId: event.sourceEventId,
      ...(event.payload.fromCatId ? { fromCatId: event.payload.fromCatId } : {}),
      toCatId: event.payload.toCatId,
    };
    const sourceMessageId = handedSourceMessageId(event);
    if (!sourceMessageId) return base;
    const message = await readReplacementMessage(messageStore, sourceMessageId, threadId, log);
    if (!isVerifiedReplacementMessage(message, threadId, event.payload.fromCatId, event.payload.toCatId)) return base;
    return {
      ...base,
      sourceMessageId,
      ...(message.extra?.coordination ? { coordination: { ...message.extra.coordination } } : {}),
    };
  }

  const base = {
    kind: 'handed_cvo' as const,
    sourceEventId: event.sourceEventId,
    fromCatId: event.payload.fromCatId,
    intent: event.payload.intent,
  };
  const sourceMessageId = event.sourceEventId.startsWith('route:') ? event.sourceEventId.slice('route:'.length) : '';
  if (!sourceMessageId) return base;
  const message = await readReplacementMessage(messageStore, sourceMessageId, threadId, log);
  if (!message || message.threadId !== threadId || message.catId !== event.payload.fromCatId) return base;
  return {
    ...base,
    sourceMessageId,
    ...(message.extra?.coordination ? { coordination: { ...message.extra.coordination } } : {}),
  };
}

async function readReplacementMessage(
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
      '[F167] replacement metadata enrichment unavailable; preserving event-derived verdict',
    );
    return null;
  }
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
  fromCatId: string | undefined,
  toCatId: string,
): message is StoredMessage {
  return Boolean(
    message &&
      message.threadId === threadId &&
      (!fromCatId || message.catId === fromCatId) &&
      (message.mentions.some((candidate) => candidate === toCatId) || message.extra?.targetCats?.includes(toCatId)),
  );
}
