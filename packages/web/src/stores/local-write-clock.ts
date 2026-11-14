import type { ChatMessage } from './chat-types';

/**
 * PR-3a2 (#6727 R1/R2): a monotonic count of writes this page made to its chat messages, kept per
 * part of a message so a write proves only what it changed.
 *
 * A History read records the count when it is issued. When it lands, the part of a message the page
 * wrote after that instant is newer than the read: the body (text, tools, thinking, streamed
 * blocks, lifecycle — a terminal snapshot is a body write) or the metadata (model, usage). Activity
 * clocks, streaming flags and stream-prefix verdicts are bookkeeping, not content, and prove
 * nothing. Bulk merges of a read itself do not count as writes.
 */
let count = 0;

export function nextLocalWriteSeq(): number {
  count += 1;
  return count;
}

export function currentLocalWriteSeq(): number {
  return count;
}

function bodyChanged(before: ChatMessage, after: ChatMessage): boolean {
  return (
    before.content !== after.content ||
    before.contentBlocks !== after.contentBlocks ||
    before.toolEvents !== after.toolEvents ||
    before.thinking !== after.thinking ||
    before.thinkingChunks !== after.thinkingChunks ||
    before.extra?.rich !== after.extra?.rich ||
    before.lifecycle !== after.lifecycle
  );
}

/** `after` with the write counts of the parts this write changed (a new message: all of it). */
export function stampMessageWrite(before: ChatMessage | undefined, after: ChatMessage): ChatMessage {
  const body = !before || bodyChanged(before, after);
  const metadata = !before ? after.metadata !== undefined : before.metadata !== after.metadata;
  if (!body && !metadata) return after;
  const seq = nextLocalWriteSeq();
  return {
    ...after,
    ...(body ? { localBodyWriteSeq: seq } : {}),
    ...(metadata ? { localMetadataWriteSeq: seq } : {}),
  };
}
