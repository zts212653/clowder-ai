/**
 * F202 Train C1 (G5) — every author's message enters the one stream subscribers read.
 *
 * Only the package messaging domain ever wrote to the messaging event log, so a subscriber saw
 * what packages said and never a cat's reply — the very message outbound delivery exists to
 * relay. Cat replies are appended through the message store from half a dozen places in the cats
 * domain, so this goes at the one seam they all already pass through. Editing those call sites
 * instead would be the same mistake in six new places, and the seventh would be written next
 * week without it.
 *
 * TRUTH VERSUS PROJECTION. The message store is the source of truth; the event log is derived
 * from it. A reply that reached the store has happened, and a derived-stream failure cannot
 * un-happen it — so a failed publish never fails the append. But it is not swallowed either: a
 * dropped publish is a message no subscriber will ever receive, so the failure is handed to a
 * required handler rather than logged and forgotten. Composition has to decide what to do with
 * it; there is deliberately no silent default.
 *
 * EVERY WRITE THAT CREATES A MESSAGE PASSES HERE. Besides `append` / `appendIdempotent`, the port
 * has two frontier writes, and production serial routing commits cat replies through one of them
 * (the F254 freshness coordinator's `appendAndObservePriorFrontier`). Forwarding those untouched
 * put the reply in the store and never on the stream (W2-5b).
 *
 * WHAT IS DELIBERATELY NOT PUBLISHED HERE:
 *  - whispers, fail-closed: being authorised for a thread is not being authorised for a
 *    restricted message inside it;
 *  - package messages, because the send path already publishes them together with the watermark
 *    write that belongs to them, and a second event here would double them;
 *  - anything that does not project — deleted and tombstoned messages have no envelope.
 */

import {
  type AppendMessageInput,
  DEFAULT_THREAD_ID,
  type IdempotentAppendResult,
  type IMessageStore,
  type StoredMessage,
  type ThreadFrontierAppendResult,
  type ThreadObservedAppendResult,
} from '../cats/services/stores/ports/MessageStore.js';
import { hasMediaRichBlocks, projectEnvelope } from './envelope.js';
import type { OutboundMediaPublication } from './outbound-media/publication.js';
import type { EventLogStore, HostPublicationTracker } from './stores/ports.js';
import { clampRetention } from './stores/ports.js';

export interface PublishingMessageStoreDeps {
  readonly events: Pick<EventLogStore, 'append'>;
  /** Schedules subscriber delivery after a durable publish. Must return immediately. */
  readonly onPublished?: (threadId: string) => void;
  /** Event-log retention per thread; the same bound the send path uses. */
  readonly retentionCount?: number;
  /**
   * Marks the store-write → publish span so a catch-up snapshot never carries a message whose
   * event is still to come (W2-5b-0). Must be the tracker shared with the messaging domain.
   */
  readonly publications?: Pick<HostPublicationTracker, 'begin'>;
  /**
   * The outbound media job (W2-5b), late-bound because it needs the media ledger. When bound, a
   * Host message carrying audio / file / gallery blocks is written with
   * `mediaPublication: 'deferred'` and handed to the job instead of being published here; when
   * not bound, such a message publishes at once with its media blocks left out, as before.
   */
  readonly outboundMedia?: () => Pick<OutboundMediaPublication, 'register' | 'schedule'> | undefined;
  /**
   * Required on purpose. A publish that is dropped silently is a message nobody will receive,
   * so there is no default that quietly discards it.
   */
  onPublishFailure(error: unknown, stored: StoredMessage): void;
}

export function createPublishingMessageStore<T extends IMessageStore>(inner: T, deps: PublishingMessageStoreDeps): T {
  const retention = clampRetention(deps.retentionCount);

  function prepare<M extends AppendMessageInput>(msg: M): M {
    if (msg.visibility === 'whisper' || msg.extra?.pluginMessage !== undefined) return msg;
    if (!hasMediaRichBlocks(msg.extra?.rich?.blocks) || !deps.outboundMedia?.()) return msg;
    return { ...msg, extra: { ...msg.extra, mediaPublication: 'deferred' } };
  }

  async function deferToMediaJob(stored: StoredMessage): Promise<void> {
    const job = deps.outboundMedia?.();
    try {
      if (!job) throw new Error('deferred media publication has no outbound media job');
      await job.register(stored);
      void job.schedule(stored.id);
    } catch (error) {
      deps.onPublishFailure(error, stored);
    }
  }

  async function publish(stored: StoredMessage): Promise<void> {
    if (stored.extra?.pluginMessage !== undefined) return;
    if (stored.visibility === 'whisper') return;
    if (stored.extra?.mediaPublication === 'deferred') return deferToMediaJob(stored);
    const envelope = projectEnvelope(stored);
    if (!envelope) return;

    try {
      // Same deterministic key the send path uses, so a retry after a crash converges on one
      // event instead of doubling a message on every subscriber's stream.
      await deps.events.append(
        stored.threadId,
        `publish:${stored.id}:1`,
        { eventId: `ev_pub_${stored.id}_1`, type: 'message.publish', envelope },
        retention,
      );
      deps.onPublished?.(stored.threadId);
    } catch (error) {
      deps.onPublishFailure(error, stored);
    }
  }

  // The span opens before the store write, so no instant exists in which the message is stored,
  // its event is still to come, and a snapshot could not tell.
  async function withinPublicationSpan<R>(threadId: string, work: () => Promise<R>): Promise<R> {
    const end = deps.publications?.begin(threadId);
    try {
      return await work();
    } finally {
      end?.();
    }
  }

  // Proxied rather than hand-forwarded: `IMessageStore` is a wide port, and a written-out
  // forwarding list would silently stop covering whatever method is added to it next.
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'append') {
        return (msg: AppendMessageInput): Promise<StoredMessage> =>
          withinPublicationSpan(msg.threadId ?? DEFAULT_THREAD_ID, async () => {
            const stored = await target.append(prepare(msg));
            await publish(stored);
            return stored;
          });
      }
      if (property === 'appendIdempotent') {
        return (msg: AppendMessageInput): Promise<IdempotentAppendResult> =>
          withinPublicationSpan(msg.threadId ?? DEFAULT_THREAD_ID, async () => {
            const result = await target.appendIdempotent(prepare(msg));
            if (!result.idempotent) await publish(result.message);
            return result;
          });
      }
      if (property === 'appendAndObservePriorFrontier') {
        return (msg: AppendMessageInput): Promise<ThreadObservedAppendResult> =>
          withinPublicationSpan(msg.threadId ?? DEFAULT_THREAD_ID, async () => {
            const result = await target.appendAndObservePriorFrontier(prepare(msg));
            if (!result.idempotent) await publish(result.message);
            return result;
          });
      }
      if (property === 'appendIfThreadFrontier') {
        return (msg: AppendMessageInput, expectedLatestMessageId: string | null): Promise<ThreadFrontierAppendResult> =>
          withinPublicationSpan(msg.threadId ?? DEFAULT_THREAD_ID, async () => {
            const result = await target.appendIfThreadFrontier(prepare(msg), expectedLatestMessageId);
            if (result.kind === 'committed') await publish(result.message);
            return result;
          });
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as T;
}
