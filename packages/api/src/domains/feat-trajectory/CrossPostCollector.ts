/**
 * F233 — CrossPostCollector (F252 Phase C prerequisite)
 *
 * Scans messages with cross-post metadata to produce `thread_merge` trajectory
 * snapshots. Each cross-post message represents a cross-thread information flow
 * — narratively a "merge" edge in the story swimlane.
 *
 * Input: Message store (cross-post messages with sourceThreadId in extra)
 * Output: CrossPostSnapshot[] for FeatTrajectoryProjector to convert to entries
 *
 * Design: collector pattern — pure data extraction, no projection logic.
 * See docs/plans/f233-f252-trajectory-emitters.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossPostSnapshot {
  kind: 'thread_merge';
  messageId: string;
  sourceThreadId: string;
  targetThreadId: string;
  catId: string;
  featId: string;
  postedAt: number;
}

/** Minimal message shape needed by this collector. */
interface CrossPostMessageLike {
  id: string;
  threadId: string;
  catId: string | null;
  timestamp: number;
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
  extra?: {
    crossPost?: {
      sourceThreadId: string;
    };
  };
}

/** Store interface — lists messages that have cross-post metadata. */
export interface IMessageStoreForCrossPost {
  listCrossPostMessages(): Promise<CrossPostMessageLike[]>;
}

/** Feat index lookup — maps threadId to featId. */
export interface IFeatIndexForCrossPost {
  lookupByThreadId(threadId: string): Promise<string | null>;
}

export interface CrossPostCollectorOptions {
  readonly messageStore: IMessageStoreForCrossPost;
  readonly featIndex: IFeatIndexForCrossPost;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class CrossPostCollector {
  private readonly messageStore: IMessageStoreForCrossPost;
  private readonly featIndex: IFeatIndexForCrossPost;

  constructor(opts: CrossPostCollectorOptions) {
    this.messageStore = opts.messageStore;
    this.featIndex = opts.featIndex;
  }

  async collectAll(): Promise<CrossPostSnapshot[]> {
    const messages = await this.messageStore.listCrossPostMessages();
    const results: CrossPostSnapshot[] = [];

    for (const msg of messages) {
      // Skip undelivered messages — queued/canceled cross-posts haven't
      // reached the target thread and shouldn't produce trajectory edges.
      if (msg.deliveryStatus === 'queued' || msg.deliveryStatus === 'canceled') continue;

      // Must have cross-post metadata with sourceThreadId
      const sourceThreadId = msg.extra?.crossPost?.sourceThreadId;
      if (!sourceThreadId) continue;

      // Look up feat association — try source thread first, fall back to target
      let featId = await this.featIndex.lookupByThreadId(sourceThreadId);
      if (!featId) {
        featId = await this.featIndex.lookupByThreadId(msg.threadId);
      }
      if (!featId) continue; // No feature association on either side — skip

      results.push({
        kind: 'thread_merge',
        messageId: msg.id,
        sourceThreadId,
        targetThreadId: msg.threadId,
        catId: msg.catId ?? 'unknown',
        featId,
        postedAt: msg.timestamp,
      });
    }

    return results;
  }
}
