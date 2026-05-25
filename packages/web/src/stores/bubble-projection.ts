/**
 * F194 Phase Z8 — Unified Canonical Bubble Projection
 *
 * Pure function: raw assistant records → canonical UI bubbles.
 * Same projection rule used by:
 *   - live reducer (each event → re-project the cat's raw record buffer)
 *   - hydrate (`mergeReplaceHydrationMessages` → project history records)
 *
 * Contract (KD-27, AC-Z20):
 *   - Stream/work-log records group by `(catId, getBubbleInvocationId(msg))` —
 *     same key as the legacy hydrate `streamKey`.
 *   - Callback-origin records with their own message id are MCP `post_message`
 *     speech, not CLI work logs; they group by their callback message id. This
 *     keeps post_msg as a separate bubble while preserving stream grouping for
 *     tool/stdout output.
 *   - Exact-key callback_final records whose id equals an existing stream record
 *     id are terminal updates for the stream bubble, not post_msg speech; they
 *     stay in the stream group to avoid duplicate bubble ids.
 *   - Records without catId or invocation key are passed through unchanged
 *     (system / user / un-namespaced bubbles).
 *   - Within a group, records are sorted by `timestamp asc` then `id asc` for
 *     determinism. The *first* (earliest) record's id becomes the canonical
 *     bubble id, but a callback record (origin === 'callback') wins the id if
 *     present — callbacks are the cat's own finalize step and their ids are
 *     server-canonical.
 *   - Content: concat non-empty `content` fragments by ts asc, separated by
 *     '\n\n'. Empty fragments skipped to avoid leading separators.
 *   - toolEvents: dedupe by `event.id`, ordered by record ts then event ts.
 *   - rich blocks (`extra.rich.blocks`): dedupe by `block.id`, preserve order
 *     (first occurrence wins).
 *   - thinking: concat non-empty `thinking` fragments by ts asc, separated by
 *     '\n\n'.
 *   - isStreaming: callback/terminal-aware (砚砚 R1 P1)。优先级：(1) 任一 record
 *     是 callback origin → false (callback 是 cat 自己 finalize，认 done); (2) 否则
 *     按 ts asc 取最后一个 record 的显式 isStreaming 值；(3) 没有显式值 → false。
 *     **不能用 ANY=true** — 旧 stream record 残留 isStreaming=true + 后到 callback
 *     final 时，ANY 会把投影 bubble 当成仍 streaming，复活我们要杀的 live 残留。
 *   - origin: 'callback' for callback groups; else 'stream'.
 *   - timestamp: earliest record ts (for stable sort).
 *
 * Why this contract evolved: Z8 made live ≡ hydrate by sharing projection.
 * Z11 fixed a blind spot where stream stdout disappeared after post_msg merge.
 * Runtime evidence then clarified the intended UI model: post_msg speech is its
 * own bubble; CLI work logs stay in the stream bubble. Projection therefore
 * still unifies live/hydrate, but does not merge callback speech into stream.
 */

import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import type { ChatMessage } from './chat-types';

interface ProjectionInput {
  /** Raw assistant records to project. May include system/user msgs which
   *  are passed through unchanged. */
  records: ChatMessage[];
}

interface ProjectionOutput {
  /** Canonical bubbles ordered by earliest timestamp asc. */
  messages: ChatMessage[];
}

interface GroupKey {
  catId: string;
  invocationId: string;
  originBucket: 'stream' | 'callback';
}

type TurnSegmentByRecord = WeakMap<ChatMessage, number>;
type StreamSegmentsByBaseKey = Map<string, Map<string, number>>;

function getBaseInvocationKey(msg: ChatMessage): string | null {
  if (msg.type !== 'assistant') return null;
  if (!msg.catId) return null;
  const inv = getBubbleInvocationId(msg as ChatMessage);
  if (!inv) return null;
  return `${msg.catId}::${inv}`;
}

function bubbleGroupKey(
  msg: ChatMessage,
  streamSegmentsByBaseKey: StreamSegmentsByBaseKey,
  turnSegmentByRecord: TurnSegmentByRecord,
): GroupKey | null {
  if (msg.type !== 'assistant') return null;
  if (!msg.catId) return null;
  const inv = getBubbleInvocationId(msg as ChatMessage);
  if (!inv) return null;
  const turnSegment = turnSegmentByRecord.get(msg) ?? 0;
  if (msg.origin === 'callback') {
    const baseKey = `${msg.catId}::${inv}`;
    if (msg.id) {
      const streamTurnSegment = streamSegmentsByBaseKey.get(baseKey)?.get(msg.id);
      if (streamTurnSegment !== undefined) {
        return { catId: msg.catId, invocationId: `${inv}::turn:${streamTurnSegment}`, originBucket: 'stream' };
      }
    }
    return { catId: msg.catId, invocationId: msg.id ?? inv, originBucket: 'callback' };
  }
  return { catId: msg.catId, invocationId: `${inv}::turn:${turnSegment}`, originBucket: 'stream' };
}

function compareRecords(a: ChatMessage, b: ChatMessage): number {
  const at = a.timestamp ?? 0;
  const bt = b.timestamp ?? 0;
  if (at !== bt) return at - bt;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

function buildTurnSegments(records: ChatMessage[]): TurnSegmentByRecord {
  const turnSegmentByRecord = new WeakMap<ChatMessage, number>();
  let segment = 0;
  for (const record of records.slice().sort(compareRecords)) {
    if (record.type === 'user') {
      segment += 1;
    }
    turnSegmentByRecord.set(record, segment);
  }
  return turnSegmentByRecord;
}

function buildStreamSegmentsByBaseKey(
  records: ChatMessage[],
  turnSegmentByRecord: TurnSegmentByRecord,
): StreamSegmentsByBaseKey {
  const streamSegmentsByBaseKey: StreamSegmentsByBaseKey = new Map();
  for (const r of records) {
    if (r.origin !== 'stream' || !r.id) continue;
    const baseKey = getBaseInvocationKey(r);
    if (!baseKey) continue;
    const turnSegment = turnSegmentByRecord.get(r);
    if (turnSegment === undefined) continue;
    const segmentsById = streamSegmentsByBaseKey.get(baseKey);
    if (segmentsById) segmentsById.set(r.id, turnSegment);
    else streamSegmentsByBaseKey.set(baseKey, new Map([[r.id, turnSegment]]));
  }
  return streamSegmentsByBaseKey;
}

function projectGroup(records: ChatMessage[]): ChatMessage {
  const sorted = records.slice().sort(compareRecords);
  const first = sorted[0]!;

  const callbackRecord = sorted.find((r) => r.origin === 'callback');
  const canonicalId = callbackRecord?.id ?? first.id;
  const origin: ChatMessage['origin'] = callbackRecord ? 'callback' : (first.origin ?? 'stream');

  const contentParts: string[] = [];
  // F194 Phase Z11 follow-up: exact-key callback_final records may still merge
  // into the stream group as terminal updates. Split content by origin so those
  // rare merged groups can surface the stream working log in the CLI Output
  // block while rendering callback text as the assistant body. Ordinary
  // post_msg callbacks have their own callback bucket and do not reach here.
  const streamContentParts: string[] = [];
  const callbackContentParts: string[] = [];
  const thinkingParts: string[] = [];
  const seenToolIds = new Set<string>();
  const toolEvents: NonNullable<ChatMessage['toolEvents']> = [];
  const seenBlockIds = new Set<string>();
  const richBlocks: NonNullable<NonNullable<ChatMessage['extra']>['rich']>['blocks'] = [];
  // cloud R2 P2 (codex): merge contentBlocks across records — stream may have
  // image/structured blocks that callback doesn't, dropping them = data loss.
  const contentBlocks: NonNullable<ChatMessage['contentBlocks']> = [];
  let mentionsUser = false;

  for (const r of sorted) {
    if (r.content && r.content.trim().length > 0) {
      contentParts.push(r.content);
      // F194 Phase Z11: bucket by origin for cliStdout / speechContent split.
      if (r.origin === 'callback') callbackContentParts.push(r.content);
      else streamContentParts.push(r.content);
    }
    if (r.thinking && r.thinking.trim().length > 0) thinkingParts.push(r.thinking);
    if (r.mentionsUser) mentionsUser = true;
    for (const ev of r.toolEvents ?? []) {
      if (seenToolIds.has(ev.id)) continue;
      seenToolIds.add(ev.id);
      toolEvents.push(ev);
    }
    for (const b of r.extra?.rich?.blocks ?? []) {
      if (seenBlockIds.has(b.id)) continue;
      seenBlockIds.add(b.id);
      richBlocks.push(b);
    }
    for (const block of r.contentBlocks ?? []) {
      contentBlocks.push(block);
    }
  }

  // F194 Phase Z8 R1 P1#1 (砚砚): callback/terminal-aware isStreaming.
  // (1) 任一 callback origin → false；(2) 否则按 ts asc 取最后 record 的显式
  // isStreaming；(3) 没有显式值 → false。
  let isStreaming = false;
  if (!callbackRecord) {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const r = sorted[i]!;
      if (typeof r.isStreaming === 'boolean') {
        isStreaming = r.isStreaming;
        break;
      }
    }
  }

  // F194 Phase Z8 cloud Codex R1 P1: preserve all assistant fields (metadata, replyTo,
  // replyPreview, visibility, whisperTo, revealedAt, deliveredAt, source, summary,
  // evidence, contentBlocks, etc.) from canonical record. Base = callback record if
  // present else first record by ts asc; then override projection-specific fields.
  const base = callbackRecord ?? first;
  const projected: ChatMessage = {
    ...base,
    id: canonicalId,
    type: 'assistant',
    catId: first.catId,
    content: contentParts.join('\n\n'),
    timestamp: first.timestamp ?? 0,
    isStreaming,
    origin,
  };
  if (toolEvents.length > 0) projected.toolEvents = toolEvents;
  else delete projected.toolEvents;
  if (thinkingParts.length > 0) projected.thinking = thinkingParts.join('\n\n');
  else delete projected.thinking;
  // cloud R2 P2 (codex): merged contentBlocks (image/structured) from all records.
  if (contentBlocks.length > 0) projected.contentBlocks = contentBlocks;
  else delete projected.contentBlocks;
  if (mentionsUser) projected.mentionsUser = true;

  // F194 Phase Z11 follow-up: merge case = exact-key terminal callback record
  // plus stream content. Expose the origin-split portions so ChatMessage keeps
  // CLI Output behavior consistent (stream working log → CLI Output stdout;
  // callback terminal text → main body). Ordinary post_msg speech is projected
  // as a separate callback bubble by bubbleGroupKey above.
  const isMergeCase = streamContentParts.length > 0 && callbackContentParts.length > 0;
  const cliStdout = isMergeCase ? streamContentParts.join('\n\n') : undefined;
  const speechContent = isMergeCase ? callbackContentParts.join('\n\n') : undefined;

  // Preserve stream identity on the projected bubble — downstream code uses
  // `getBubbleInvocationId` to dedupe further (e.g. live cleanup, suppression).
  const firstStream = sorted.find((r) => r.extra?.stream)?.extra?.stream;
  const baseExtra = base.extra ?? {};
  if (firstStream || richBlocks.length > 0 || isMergeCase || Object.keys(baseExtra).length > 0) {
    const extra: NonNullable<ChatMessage['extra']> = { ...baseExtra };
    if (firstStream || isMergeCase) {
      extra.stream = {
        ...firstStream,
        ...(cliStdout !== undefined ? { cliStdout } : {}),
        ...(speechContent !== undefined ? { speechContent } : {}),
      };
    }
    if (richBlocks.length > 0) extra.rich = { v: 1, blocks: richBlocks };
    projected.extra = extra;
  }

  return projected;
}

/**
 * Apply Z8 unified canonical projection to raw records.
 *
 * Records without a (catId, invocationId) namespace pass through unchanged
 * and keep their original position (sorted by timestamp asc among themselves).
 * Records with a key are grouped and each group becomes one canonical bubble.
 */
export function projectCanonicalBubbles({ records }: ProjectionInput): ProjectionOutput {
  const groupedKeys = new Map<string, ChatMessage[]>();
  const passthrough: ChatMessage[] = [];
  const turnSegmentByRecord = buildTurnSegments(records);
  const streamSegmentsByBaseKey = buildStreamSegmentsByBaseKey(records, turnSegmentByRecord);

  for (const r of records) {
    const k = bubbleGroupKey(r, streamSegmentsByBaseKey, turnSegmentByRecord);
    if (!k) {
      passthrough.push(r);
      continue;
    }
    const keyStr = `${k.originBucket}::${k.catId}::${k.invocationId}`;
    const list = groupedKeys.get(keyStr);
    if (list) list.push(r);
    else groupedKeys.set(keyStr, [r]);
  }

  const projected: ChatMessage[] = [];
  for (const list of groupedKeys.values()) {
    projected.push(projectGroup(list));
  }
  for (const p of passthrough) {
    projected.push(p as ChatMessage);
  }

  projected.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || (a.id ?? '').localeCompare(b.id ?? ''));
  return { messages: projected };
}
