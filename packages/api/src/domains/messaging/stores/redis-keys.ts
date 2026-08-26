/**
 * Plugin Messaging — Redis key builders (K-1 / F288)
 *
 * Namespace: plugmsg:* — collision-free with existing cat-cafe keyspaces.
 * Caller-supplied segments (instanceId, subscriptionId, ledger keys already
 * URI-encode their own segments in MessagingLedger) are encoded defensively;
 * host-generated ids (handleId, threadId, messageId) are used as-is.
 */

const enc = encodeURIComponent;

export const MessagingKeyPrefixes = {
  subscription: 'plugmsg:sub:',
  subscriptionSnapshot: 'plugmsg:subsnap:',
  subscriptionSnapshotItems: 'plugmsg:subsnapitems:',
  subscriptionSnapshotCapture: 'plugmsg:subsnapcapture:',
  subscriptionSnapshotCaptureItems: 'plugmsg:subsnapcaptureitems:',
} as const;

export const MessagingKeys = {
  /** String: HandleRecord JSON. */
  handle: (handleId: string): string => `plugmsg:handle:${handleId}`,
  /** String: ledger entry JSON with PX ttl. `key` is pre-encoded by MessagingLedger. */
  ledger: (key: string): string => `plugmsg:ledger:${key}`,
  /** ZSET: member = `${encodedEventKey}|${eventJson}`, score = sequence. */
  events: (threadId: string): string => `plugmsg:events:${threadId}`,
  /** String counter: per-thread sequence head (INCR). */
  eventSeq: (threadId: string): string => `plugmsg:evseq:${threadId}`,
  /** HASH: encodedEventKey → sequence (window-bounded dedupe, trimmed with events). */
  eventDedupe: (threadId: string): string => `plugmsg:evdedup:${threadId}`,
  /** String: SubscriptionRecord identity JSON (immutable fields + revokedAt). */
  subscription: (instanceId: string, subscriptionId: string): string =>
    `${MessagingKeyPrefixes.subscription}${enc(instanceId)}:${enc(subscriptionId)}`,
  /** HASH: { acked, delivered } live cursor values (Lua max-advance). */
  subscriptionCursor: (instanceId: string, subscriptionId: string): string =>
    `plugmsg:subcur:${enc(instanceId)}:${enc(subscriptionId)}`,
  /** String: active frozen snapshot view or its last consumed completion marker. */
  subscriptionSnapshot: (instanceId: string, subscriptionId: string): string =>
    `${MessagingKeyPrefixes.subscriptionSnapshot}${enc(instanceId)}:${enc(subscriptionId)}`,
  /** LIST: frozen MessageEnvelope JSON rows, page-addressable by offset. */
  subscriptionSnapshotItems: (instanceId: string, subscriptionId: string): string =>
    `${MessagingKeyPrefixes.subscriptionSnapshotItems}${enc(instanceId)}:${enc(subscriptionId)}`,
  /** String: unpublished bounded capture lease and staged item count. */
  subscriptionSnapshotCapture: (instanceId: string, subscriptionId: string): string =>
    `${MessagingKeyPrefixes.subscriptionSnapshotCapture}${enc(instanceId)}:${enc(subscriptionId)}`,
  /** LIST: unpublished frozen rows; renamed atomically only after full capture validation. */
  subscriptionSnapshotCaptureItems: (instanceId: string, subscriptionId: string): string =>
    `${MessagingKeyPrefixes.subscriptionSnapshotCaptureItems}${enc(instanceId)}:${enc(subscriptionId)}`,
  /** String: live subscriptionId for (instance, handle) — subscribe idempotency. */
  subscriptionByHandle: (instanceId: string, handleId: string): string =>
    `plugmsg:subidx:${enc(instanceId)}:${handleId}`,
  /** SET: `${enc(instanceId)}|${enc(subscriptionId)}` members — revocation cascade. */
  subscriptionsOfHandle: (handleId: string): string => `plugmsg:subsofhandle:${handleId}`,
  /** String: lock token with PX ttl. */
  appendLock: (messageId: string): string => `plugmsg:lock:append:${messageId}`,
  /** String: opaque handleId for a message (ensureMessageHandle idempotency). */
  handleByMessage: (messageId: string): string => `plugmsg:mhidx:${messageId}`,
} as const;
