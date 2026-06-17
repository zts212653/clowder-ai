/**
 * F232 Phase A: Thread 产物聚合器（纯函数）
 *
 * 把三个来源映射成统一的 ThreadArtifactDTO[]，去重（按 ref，取最新）后时间倒序：
 *  1. thread 消息里的 rich blocks（media_gallery / file / diff / audio）
 *  2. PR tasks（kind=pr_tracking）
 *  3. threadMemory.recentArtifacts ledger 里 type=file 的条目
 *
 * 设计说明：
 * - 不复用 artifact-tracking.ts 的 mergeLedger（它 cap 到 20，thread 全量产物可能更多）；
 *   这里自写不设上限的去重。
 * - classifyPath/labelFromPath 在 artifact-tracking.ts 是私有，故不依赖；本聚合器的
 *   分类直接由数据源类型决定（rich block kind / task kind / ledger entry type）。
 */

import type { RichBlock, ThreadArtifactDTO } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';

const THREAD_SCAN_PAGE = 200;

/**
 * F232 P1 fix: 分页扫完整 thread 的全部消息。`getByThread` 默认 limit=50 会截断 >50 条
 * 消息的 thread 的早期产物（违反 AC-A1 全量聚合）。用 getByThreadBefore 游标循环扫到底。
 */
export async function collectAllThreadMessages(
  store: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>,
  threadId: string,
  userId?: string,
  // pageSize 暴露仅为可测试性（默认 = THREAD_SCAN_PAGE，生产行为不变）：
  // 分页 cursor 路径只在「满页」时触发，小页让 Redis-backed 测试无需造 200+ 条消息
  // 即可覆盖 queued→delivered re-score 跨页场景（对齐 F099 rightPanelToggleTransition 导出思路）。
  pageSize: number = THREAD_SCAN_PAGE,
): Promise<StoredMessage[]> {
  const all: StoredMessage[] = [];
  let cursor: { ts: number; id: string } | undefined;
  for (;;) {
    const page = cursor
      ? await store.getByThreadBefore(threadId, cursor.ts, pageSize, cursor.id, userId)
      : await store.getByThread(threadId, pageSize, userId);
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    // getByThread/getByThreadBefore 返回 oldest→newest（最老在 page[0]）。
    // cursor 必须取当前页最老的一条，才能继续往「更老」分页；用最新一条会重叠重扫整页。
    const oldest = page[0];
    // F232 P2 fix（cloud review）：thread zset 的 score = effective order time——
    // queued 消息投递后 markDelivered 会把 score re-score 到 deliveredAt（见 RedisMessageStore）。
    // 游标必须用同一时间（deliveredAt ?? timestamp），否则下一页 getByThreadBefore 以原始
    // timestamp 为上界（score < timestamp），会跳过 score 落在 (timestamp, deliveredAt) 的消息，
    // 其 artifacts 从 GET /api/threads/:threadId/artifacts 中漏聚合。
    cursor = { ts: oldest.deliveredAt ?? oldest.timestamp, id: oldest.id };
  }
  return all;
}

export interface AggregatorMessage {
  id: string;
  catId: string | null;
  timestamp: number;
  extra?: { rich?: { blocks?: RichBlock[] } };
}

export interface AggregatorPrTask {
  subjectKey: string | null;
  title: string;
  ownerCatId: string | null;
  status: string;
  updatedAt: number;
  sourceMessageId?: string | null;
}

export interface AggregatorFileLedgerEntry {
  ref: string;
  label: string;
  updatedAt: number;
  updatedBy: string;
}

export interface ThreadArtifactsAggregatorInput {
  messages: AggregatorMessage[];
  prTasks: AggregatorPrTask[];
  fileLedger: AggregatorFileLedgerEntry[];
}

const AUDIO_NAME_MAX = 24;

/** F232 A.2: video 扩展名集合——mimeType 优先，扩展名 fallback（无 mimeType 的旧 file block）。 */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', 'ogv']);
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 单个 rich block → 产物（每 kind 一个 flat mapper；不收录的 kind 返回 []）。 */
function blockToArtifacts(b: RichBlock, msg: AggregatorMessage): ThreadArtifactDTO[] {
  const base = { catId: msg.catId, createdAt: msg.timestamp, sourceMessageId: msg.id };
  switch (b.kind) {
    case 'media_gallery':
      return b.items.map(
        (item): ThreadArtifactDTO => ({
          ...base,
          type: 'image',
          name: item.caption ?? item.alt ?? 'image',
          url: item.url,
        }),
      );
    case 'file': {
      // AC-A9: video 识别——mimeType 优先，扩展名 fallback
      const isVideo = b.mimeType ? b.mimeType.startsWith('video/') : VIDEO_EXTENSIONS.has(extensionOf(b.fileName));
      return [{ ...base, type: isVideo ? 'video' : 'file', name: b.fileName, url: b.url }];
    }
    case 'diff':
      return [{ ...base, type: 'code', name: b.filePath, ref: b.filePath }];
    case 'audio':
      return [
        { ...base, type: 'audio', name: b.title ?? (b.text ? b.text.slice(0, AUDIO_NAME_MAX) : 'voice'), url: b.url },
      ];
    default:
      return []; // card / checklist / interactive / html_widget 不收录（F232 OQ-3）
  }
}

function richBlocksToArtifacts(messages: AggregatorMessage[]): ThreadArtifactDTO[] {
  const out: ThreadArtifactDTO[] = [];
  for (const msg of messages) {
    for (const b of msg.extra?.rich?.blocks ?? []) {
      out.push(...blockToArtifacts(b, msg));
    }
  }
  return out;
}

function prTasksToArtifacts(prTasks: AggregatorPrTask[]): ThreadArtifactDTO[] {
  const out: ThreadArtifactDTO[] = [];
  for (const task of prTasks) {
    if (!task.subjectKey) continue;
    const prRef = task.subjectKey.replace(/^pr:/, '');
    out.push({
      type: 'pr',
      name: task.title,
      catId: task.ownerCatId,
      createdAt: task.updatedAt,
      sourceMessageId: task.sourceMessageId ?? null,
      ref: prRef,
    });
  }
  return out;
}

function fileLedgerToArtifacts(fileLedger: AggregatorFileLedgerEntry[]): ThreadArtifactDTO[] {
  return fileLedger.map((f) => ({
    type: 'file' as const,
    name: f.label,
    catId: f.updatedBy,
    createdAt: f.updatedAt,
    sourceMessageId: null,
    ref: f.ref,
  }));
}

/** 按 ref 去重（保留 createdAt 最新）；无 ref 的产物全部保留。不设上限。 */
function dedupeByRef(artifacts: ThreadArtifactDTO[]): ThreadArtifactDTO[] {
  const byRef = new Map<string, ThreadArtifactDTO>();
  const noRef: ThreadArtifactDTO[] = [];
  for (const a of artifacts) {
    if (a.ref == null) {
      noRef.push(a);
      continue;
    }
    const prev = byRef.get(a.ref);
    if (!prev || a.createdAt >= prev.createdAt) byRef.set(a.ref, a);
  }
  return [...byRef.values(), ...noRef];
}

export function aggregateThreadArtifacts(input: ThreadArtifactsAggregatorInput): ThreadArtifactDTO[] {
  const all = [
    ...richBlocksToArtifacts(input.messages),
    ...prTasksToArtifacts(input.prTasks),
    ...fileLedgerToArtifacts(input.fileLedger),
  ];
  return dedupeByRef(all).sort((a, b) => b.createdAt - a.createdAt);
}
