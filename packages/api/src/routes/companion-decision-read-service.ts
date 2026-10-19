import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import {
  type IgnoredItemSnapshot,
  ignoredItemSnapshotSchema,
  type RichInteractiveBlock,
  type RuntimeInteractionRecord,
} from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { RuntimeInteractionPendingReadSource } from '../domains/runtime-interaction/ports/RuntimeInteractionStore.js';
import { readVerifiedRuntimeInteractionPresentation } from '../domains/runtime-interaction/RuntimeInteractionCardPublisher.js';
import { normalizeRuntimeInteractionRecord } from '../domains/runtime-interaction/RuntimeInteractionRecordModel.js';
import { readCollectiveAccountabilityAttentionSource } from './companion-collective-accountability-source.js';
import { projectCompanionDecisions } from './companion-decision-projection.js';
import {
  approvalsSourceSchema,
  assertDecisionOwner,
  type DecisionSourceRead,
  needsMeSourceSchema,
} from './companion-decision-sources.js';
import {
  type OriginalApprovalCardMessageStore,
  readOriginalApprovalCards,
} from './companion-original-approval-cards.js';
import { type MentionReadOptions, readUserMentionTodos } from './user-mention-todo-projection.js';

export interface DecisionPersonalPreferenceReadOptions {
  mode: 'visible' | 'ignored';
  read?: (ownerUserId: string) => IgnoredItemSnapshot | Promise<IgnoredItemSnapshot>;
}

/** Each source is independently read and fenced to this request's principal. No cache or writer. */
export async function readCompanionDecisionProjection(
  app: FastifyInstance,
  userId: string,
  page: { offset: number; limit: number },
  messageStore?: Pick<IMessageStore, 'listUserMentionRequests'> &
    Partial<
      Pick<IMessageStore, 'listHandledUserMentions' | 'getUserMentionStateRevisions' | 'getUserMentionHandlingMetadata'>
    >,
  mentionOptions?: MentionReadOptions,
  runtimeInteractionStore?: RuntimeInteractionPendingReadSource,
  personalPreferences?: DecisionPersonalPreferenceReadOptions,
  sourceMessageStore?: OriginalApprovalCardMessageStore,
  collectiveConnector?: () => CollectiveConnector | undefined,
) {
  const config = {
    approvals: {
      url: '/api/approval-hub/pending',
      coverage: 'all_registered_F246_producers' as const,
      parse(value: unknown) {
        const body = approvalsSourceSchema.parse(value);
        assertDecisionOwner(body.items, [], userId);
        return body;
      },
    },
    needsMe: {
      url: '/api/entrusted-work/needs-me',
      coverage: 'current_linked_F310_five_producers' as const,
      parse(value: unknown) {
        const body = needsMeSourceSchema.parse(value);
        assertDecisionOwner([], body.ownerReads, userId);
        return body;
      },
    },
  };
  const read = async (kind: 'approvals' | 'needsMe') => {
    const startedAt = Date.now();
    const { url, coverage, parse } = config[kind];
    let status: DecisionSourceRead['status'] = 'unavailable';
    let exhaustiveness: DecisionSourceRead['exhaustiveness'] = 'unknown';
    let body: unknown;
    try {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-cat-cafe-user': userId },
      });
      status = sourceStatus(response.statusCode);
      if (response.statusCode === 200) {
        const parsed = parse(response.json());
        body = parsed;
        exhaustiveness = parsed.coverage?.state ?? 'unknown';
        status = 'available';
      }
    } catch {
      body = undefined;
    }
    return {
      body: status === 'available' ? body : undefined,
      state: { status, coverage, exhaustiveness, startedAt, observedAt: Date.now() } satisfies DecisionSourceRead,
    };
  };
  const [approvals, needsMe, userMentions, structuredChoices, personal, collectiveAccountability] = await Promise.all([
    read('approvals'),
    read('needsMe'),
    messageStore ? readUserMentionTodos(messageStore, userId, mentionOptions) : undefined,
    runtimeInteractionStore ? readStructuredChoices(runtimeInteractionStore, userId, sourceMessageStore) : undefined,
    personalPreferences ? readDecisionPersonalPreferences(personalPreferences, userId) : undefined,
    collectiveConnector ? readCollectiveAccountabilityAttentionSource(collectiveConnector(), userId) : undefined,
  ]);
  const approvalBody = approvals.body ? approvalsSourceSchema.parse(approvals.body) : undefined;
  const originalApprovalCards = approvalBody
    ? await readOriginalApprovalCards(
        approvalBody.items,
        userId,
        sourceMessageStore ?? originalCardStoreFromMentionStore(messageStore),
      )
    : undefined;
  if (originalApprovalCards) approvals.state.observedAt = Date.now();
  const projection = projectCompanionDecisions(
    approvals.body ?? { items: [] },
    needsMe.body ?? { ownerReads: [] },
    userId,
    page,
    Date.now(),
    {
      approvals: approvals.state,
      needsMe: needsMe.state,
      ...(structuredChoices ? { structuredChoices: structuredChoices.state } : {}),
    },
    userMentions,
    structuredChoices?.body,
    personalPreferences && personal
      ? { mode: personalPreferences.mode, snapshot: personal.snapshot, state: personal.state }
      : undefined,
    originalApprovalCards,
    structuredChoices?.conversationPresentations,
    collectiveAccountability,
  );
  await Promise.all(
    projection.items.map(async (row) => {
      if (!row.userMention) return;
      try {
        const thread = await mentionOptions?.threads?.get(row.userMention.threadId);
        row.userMention.threadTitle =
          thread?.createdBy === userId ? thread.title?.trim() || row.userMention.threadId : row.userMention.threadId;
      } catch {
        row.userMention.threadTitle = row.userMention.threadId;
      }
    }),
  );
  return projection;
}

function originalCardStoreFromMentionStore(value: unknown): OriginalApprovalCardMessageStore | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const getById = Reflect.get(value, 'getById');
  return typeof getById === 'function' ? (value as OriginalApprovalCardMessageStore) : undefined;
}

export async function readDecisionPersonalPreferences(
  options: DecisionPersonalPreferenceReadOptions,
  userId: string,
): Promise<{ snapshot?: IgnoredItemSnapshot; state: DecisionSourceRead }> {
  const startedAt = Date.now();
  const base = { coverage: 'owner_personal_ignored_items' as const, startedAt };
  if (!options.read) {
    return {
      state: { ...base, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' },
    };
  }
  try {
    const parsed = ignoredItemSnapshotSchema.safeParse(await options.read(userId));
    if (!parsed.success || parsed.data.ownerUserId !== userId) {
      return { state: { ...base, observedAt: Date.now(), status: 'invalid', exhaustiveness: 'unknown' } };
    }
    return {
      snapshot: parsed.data,
      state: { ...base, observedAt: Date.now(), status: 'available', exhaustiveness: 'complete' },
    };
  } catch {
    return {
      state: { ...base, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' },
    };
  }
}

async function readStructuredChoices(
  store: RuntimeInteractionPendingReadSource,
  userId: string,
  messageStore?: OriginalApprovalCardMessageStore,
): Promise<{
  body?: RuntimeInteractionRecord[];
  conversationPresentations?: ReadonlyMap<string, RichInteractiveBlock>;
  state: DecisionSourceRead;
}> {
  const startedAt = Date.now();
  const base = {
    coverage: 'pending_f306_structured_choices' as const,
    startedAt,
    observedAt: Date.now(),
  };
  let source: { records: RuntimeInteractionRecord[]; exhaustiveness: DecisionSourceRead['exhaustiveness'] };
  try {
    source = await loadStructuredChoiceRecords(store, userId);
  } catch {
    return { state: { ...base, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' } };
  }
  let verified: { records: RuntimeInteractionRecord[]; presentations: Map<string, RichInteractiveBlock> };
  try {
    verified = await verifyStructuredChoiceRecords(source.records, userId, messageStore);
  } catch {
    return { state: { ...base, observedAt: Date.now(), status: 'invalid', exhaustiveness: 'unknown' } };
  }
  return {
    body: verified.records.filter((record) => record.status === 'pending' && !record.submission),
    conversationPresentations: verified.presentations,
    state: { ...base, observedAt: Date.now(), status: 'available', exhaustiveness: source.exhaustiveness },
  };
}

async function loadStructuredChoiceRecords(store: RuntimeInteractionPendingReadSource, userId: string) {
  if (store.readPendingIndexByUser) return store.readPendingIndexByUser(userId);
  return { records: await store.listPendingByUser(userId), exhaustiveness: 'partial' as const };
}

async function verifyStructuredChoiceRecords(
  sourceRecords: RuntimeInteractionRecord[],
  userId: string,
  messageStore?: OriginalApprovalCardMessageStore,
): Promise<{ records: RuntimeInteractionRecord[]; presentations: Map<string, RichInteractiveBlock> }> {
  const records = sourceRecords.map((record) => normalizeRuntimeInteractionRecord(record));
  const presentations = new Map<string, RichInteractiveBlock>();
  for (const record of records) {
    assertStructuredChoiceRecord(record, userId);
    const presentation = await readConversationPresentation(record, messageStore);
    if (presentation) presentations.set(record.request.interactionId, presentation);
  }
  return { records, presentations };
}

function assertStructuredChoiceRecord(record: RuntimeInteractionRecord, userId: string): void {
  if (
    !isPendingIndexSnapshotStatus(record.status) ||
    record.request.owner.userId !== userId ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0 ||
    !validCardRef(record)
  ) {
    throw new Error('structured choice source identity mismatch');
  }
}

async function readConversationPresentation(
  record: RuntimeInteractionRecord,
  messageStore?: OriginalApprovalCardMessageStore,
): Promise<RichInteractiveBlock | undefined> {
  if (record.status !== 'pending' || record.submission || record.request.kind !== 'conversation_decision') {
    return undefined;
  }
  const stored = messageStore ? await messageStore.getById(record.cardRef?.messageId ?? '') : null;
  const block = record.cardRef
    ? readVerifiedRuntimeInteractionPresentation(stored, record.request, record.cardRef)
    : null;
  return block?.kind === 'interactive' ? block : undefined;
}

function isPendingIndexSnapshotStatus(status: RuntimeInteractionRecord['status']): boolean {
  return ['pending', 'answered', 'declined', 'cancelled', 'invalidated'].includes(status);
}

function validCardRef(record: RuntimeInteractionRecord): boolean {
  const { cardRef } = record;
  const canonicalAddress = Boolean(
    cardRef &&
      cardRef.threadId === record.request.owner.threadId &&
      cardRef.threadId.trim().length > 0 &&
      cardRef.messageId.trim().length > 0 &&
      cardRef.blockId.trim().length > 0,
  );
  if (!canonicalAddress || !cardRef) return false;
  if (record.request.kind !== 'conversation_decision') return true;
  return Boolean(
    cardRef.blockDigest &&
      /^[a-f0-9]{64}$/.test(cardRef.blockDigest) &&
      Number.isSafeInteger(cardRef.publishedAt) &&
      cardRef.publishedAt !== undefined &&
      cardRef.publishedAt >= 0,
  );
}

function sourceStatus(code: number): DecisionSourceRead['status'] {
  if (code === 200) return 'invalid';
  if (code === 401) return 'unauthenticated';
  if (code === 403) return 'forbidden';
  return 'unavailable';
}

/** Explicit adoption keeps existing F317 readers on their available-only wire contract. */
export function companionDecisionWireResponse(result: ReturnType<typeof projectCompanionDecisions>, view?: 'unified') {
  if (view !== 'unified' && result.status !== 'available') {
    return {
      statusCode: 503,
      body: {
        status: 'unavailable' as const,
        scope: result.scope,
        observedAt: result.observedAt,
        sources: result.sources,
      },
    };
  }
  return { statusCode: result.status === 'unavailable' ? 503 : 200, body: result };
}
