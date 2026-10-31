import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCatId, dotAskArguments } from '@cat-cafe/shared';
import type { z } from 'zod';
import type { QueueTargetExecutionReadPort } from '../../agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import { analyzeA2AMentions } from '../../agents/routing/a2a-mentions.js';
import { resolveCatTarget } from '../../agents/routing/cat-target-resolver.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { DotConnectionService } from './DotConnectionService.js';
import { DOT_CAT_ID, type DotConnectionState } from './dot-connection-state.js';
import { type DotReplyCandidate, dotReplyRequest } from './dot-reply-authority.js';

type Ask = z.infer<typeof dotAskArguments>;
export type DotAskMetadata = NonNullable<NonNullable<StoredMessage['extra']>['dotAsk']>;
export interface DotAskAdmission {
  metadata: DotAskMetadata;
  idempotencyKey: string;
  idempotencyScope: string;
  state: DotConnectionState;
  input: Ask;
}

/** A persisted question or one process-local child is not a complete fan-out receipt. */
export async function hasCompleteDotAskFanout(
  message: StoredMessage | null | undefined,
  queue: QueueTargetExecutionReadPort | undefined,
): Promise<boolean> {
  const recipients = message?.extra?.dotAsk?.recipientCatIds;
  if (!message || !recipients?.length || message.lifecycle?.kind !== 'input') return false;
  const refs = message.lifecycle.dispatchRefs ?? [];
  const rows = (await queue?.getDurableEntriesForMessages(message.threadId, [message.id]))?.get(message.id) ?? [];
  return recipients.every(
    (target) =>
      refs.filter((ref) => ref.targetId === target).length === 1 ||
      rows.some(
        (row) =>
          row.threadId === message.threadId &&
          row.owner.kind === 'user' &&
          row.owner.userId === message.userId &&
          row.payload.messageId === message.id &&
          row.payload.sourceRecordId === message.id &&
          isDeepStrictEqual(row.from, message.from) &&
          row.targets.includes(target) &&
          (row.status === 'queued' || row.status === 'claimed'),
      ),
  );
}

/** The Host grants a fixed dot-author capability. No caller flag, key selector or new question store. */
export class DotAskService {
  private readonly admission = new AsyncLocalStorage<DotAskAdmission>();
  constructor(
    private readonly options: {
      connection: DotConnectionService;
      messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>;
      threads: Pick<IThreadStore, 'get' | 'getParticipants'>;
      enabled: () => Promise<boolean>;
      post: (
        secret: string,
        input: { threadId: string; content: string; targetCats: string[]; clientMessageId: string },
      ) => Promise<unknown>;
    },
  ) {}

  async ask(secret: string, raw: Ask) {
    const input = dotAskArguments.parse(raw);
    const state = await this.ready(secret, input.attempt_id);
    const subscriptionId = state.subscription?.id;
    if (!subscriptionId) throw new Error('dot_subscription_required');
    const thread = await this.options.threads.get(input.thread_id);
    if (!thread || thread.deletedAt || thread.createdBy !== state.ownerUserId)
      throw new Error('dot_ask_thread_rejected');
    const participants = await this.options.threads.getParticipants(thread.id);
    const targets = [...new Set(input.target_cat_ids)].sort();
    for (const target of targets) {
      const resolved = resolveCatTarget(target);
      if (
        !('ok' in resolved) ||
        resolved.ok !== target ||
        target === DOT_CAT_ID ||
        !participants.includes(createCatId(target))
      )
        throw new Error('dot_ask_recipient_rejected');
    }
    const text = analyzeA2AMentions(input.content, createCatId(DOT_CAT_ID));
    if (
      text.routing_warnings.length ||
      text.mentions.some((target) => !targets.includes(target)) ||
      (text.mentions.length === 1 && targets.length > 1)
    )
      throw new Error('dot_ask_target_mismatch');
    const idempotencyKey = `dot-ask:${createHash('sha256')
      .update(JSON.stringify([state.ownerUserId, state.attemptId, input.client_message_id]))
      .digest('hex')}`;
    const requestDigest = createHash('sha256')
      .update(JSON.stringify([thread.id, targets, input.content]))
      .digest('hex');
    const scope = `dot-ask:${state.attemptId}`;
    const existing = await this.options.messages.getByIdempotencyKey(state.ownerUserId, scope, idempotencyKey);
    if (existing && existing.extra?.dotAsk?.requestDigest !== requestDigest)
      throw new Error('dot_ask_idempotency_conflict');
    const context: DotAskAdmission = {
      state,
      input: { ...input, target_cat_ids: targets },
      idempotencyKey,
      idempotencyScope: scope,
      metadata: {
        v: 1,
        ownerUserId: state.ownerUserId,
        attemptId: state.attemptId,
        subscriptionId,
        recipientCatIds: targets,
        requestKey: idempotencyKey,
        requestDigest,
      },
    };
    // Async scope exists only around Host-owned injection of the canonical writer.
    // An external generic callback, even with the internal dot key, has no admission.
    return this.admission.run(context, () =>
      this.options.post(state.credentialSecret, {
        threadId: thread.id,
        content: input.content,
        targetCats: targets,
        clientMessageId: input.client_message_id,
      }),
    );
  }

  async admit(input: {
    agentKeyId: string;
    userId: string;
    threadId: string;
    content: string;
    targetCats: readonly string[];
    clientMessageId?: string;
  }) {
    const context = this.admission.getStore();
    if (
      !context ||
      input.agentKeyId !== context.state.agentKeyId ||
      input.userId !== context.state.ownerUserId ||
      input.threadId !== context.input.thread_id ||
      input.content !== context.input.content ||
      input.clientMessageId !== context.input.client_message_id ||
      JSON.stringify([...input.targetCats].sort()) !== JSON.stringify(context.input.target_cat_ids)
    )
      throw new Error('dot_ask_not_admitted');
    await this.ready(context.state.credentialSecret, context.state.attemptId);
    const thread = await this.options.threads.get(input.threadId);
    const participants = await this.options.threads.getParticipants(input.threadId);
    if (
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== input.userId ||
      input.targetCats.some((cat) => !participants.includes(createCatId(cat)))
    )
      throw new Error('dot_ask_recipient_rejected');
    return context;
  }

  async replyTarget(source: DotReplyCandidate) {
    // Preserve the exact relationship even when currently disabled, so the pending
    // reply is never silently rerouted to Pro or to a different subscription.
    return !!(await dotReplyRequest(source, this.options.messages));
  }

  private async ready(secret: string, attemptId: string) {
    const state = await this.options.connection.authenticate(secret);
    if (state.attemptId !== attemptId) throw new Error('dot_attempt_mismatch');
    if (!(await this.options.enabled())) throw new Error('dot_disabled');
    if (
      state.pairedAt === null ||
      !state.subscription ||
      (state.subscription.expiresAt !== null && state.subscription.expiresAt <= Date.now())
    )
      throw new Error('dot_subscription_required');
    return state;
  }
}
