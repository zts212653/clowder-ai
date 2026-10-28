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

import {
  isSourceCodeExtension,
  type MessageContent,
  messageMediaItemKey,
  projectFileContent,
  type RichBlock,
  type ThreadArtifactDTO,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../stores/visibility.js';

const THREAD_SCAN_PAGE = 200;

type ThreadMessageScanStore = Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;

/** Preserve publication-order cursors and owner visibility for every historical page. */
async function* readThreadMessagePages(
  store: ThreadMessageScanStore,
  threadId: string,
  userId?: string,
  pageSize: number = THREAD_SCAN_PAGE,
  artifactProjection = false,
): AsyncGenerator<StoredMessage[]> {
  const options = { includeQueuedCatMessages: true, ...(artifactProjection ? { artifactProjection: true } : {}) };
  let cursor: { ts: number; id: string } | undefined;
  for (;;) {
    const page = cursor
      ? await store.getByThreadBefore(threadId, cursor.ts, pageSize, cursor.id, userId, options)
      : await store.getByThread(threadId, pageSize, userId, options);
    if (page.length === 0) break;
    yield page;
    if (page.length < pageSize) break;
    // Pages are oldest→newest; continue from the oldest publication cursor.
    const oldest = page[0];
    cursor = { ts: getTimelineOrderTime(oldest), id: oldest.id };
  }
}

/** Legacy full-message contract, including complete historical pagination. */
export async function collectAllThreadMessages(
  store: ThreadMessageScanStore,
  threadId: string,
  userId?: string,
  pageSize: number = THREAD_SCAN_PAGE,
): Promise<StoredMessage[]> {
  const all: StoredMessage[] = [];
  for await (const page of readThreadMessagePages(store, threadId, userId, pageSize)) {
    for (const message of page) all.push(message);
  }
  return all;
}

/** Retain only artifact DTOs; unrelated raw message payloads can retire after each page. */
export async function collectThreadMessageArtifacts(
  store: ThreadMessageScanStore,
  threadId: string,
  userId?: string,
  observePage?: (page: readonly StoredMessage[]) => void,
): Promise<ThreadArtifactDTO[]> {
  const artifacts: ThreadArtifactDTO[] = [];
  for await (const page of readThreadMessagePages(store, threadId, userId, THREAD_SCAN_PAGE, true)) {
    observePage?.(page);
    // Preserve traversal order: equal-time ref replacement and no-ref ties depend on it.
    for (const artifact of projectMessageArtifacts(page)) artifacts.push(artifact);
  }
  return artifacts;
}

export interface AggregatorMessage {
  id: string;
  catId: string | null;
  timestamp: number;
  extra?: { rich?: { blocks?: RichBlock[] } };
  contentBlocks?: readonly MessageContent[];
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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function ledgerArtifactType(f: AggregatorFileLedgerEntry): 'file' | 'code' {
  const ext = extensionOf(f.ref);
  return isSourceCodeExtension(ext) ? 'code' : 'file';
}

type ArtifactVisitor = (artifact: ThreadArtifactDTO) => void;

/** 单个 rich block → 产物；visitor 让有界 reader 不必先物化整个 gallery。 */
function visitBlockArtifacts(b: RichBlock, msg: AggregatorMessage, visit: ArtifactVisitor): void {
  const base = { catId: msg.catId, createdAt: msg.timestamp, sourceMessageId: msg.id };
  switch (b.kind) {
    case 'media_gallery': {
      for (const [itemIndex, item] of b.items.entries()) {
        visit({
          ...base,
          type: 'image',
          name: item.caption ?? item.alt ?? 'image',
          url: item.url,
          publicationItem: { kind: 'media-gallery', blockId: b.id, itemIndex },
        });
      }
      return;
    }
    case 'file': {
      // AC-A9: video 识别——mimeType 优先，扩展名 fallback
      const isVideo = projectFileContent({ name: b.fileName, url: b.url, mime: b.mimeType }).kind === 'video';
      visit({
        ...base,
        type: isVideo ? 'video' : 'file',
        name: b.fileName,
        ...(b.mimeType ? { mime: b.mimeType } : {}),
        url: b.url,
        publicationItem: { kind: 'rich-file', blockId: b.id },
      });
      return;
    }
    case 'diff':
      visit({ ...base, type: 'code', name: b.filePath, ref: b.filePath });
      return;
    case 'audio':
      visit({
        ...base,
        type: 'audio',
        name: b.title ?? (b.text ? b.text.slice(0, AUDIO_NAME_MAX) : 'voice'),
        url: b.url,
      });
      return;
    case 'html_widget':
      // 只带定位，不带 HTML 正文：面板按坐标回原消息读取，并在读取时复核 kind。
      visit({ ...base, type: 'widget', name: b.title ?? 'Widget', widgetBlockId: b.id });
      return;
    case 'interactive':
      // interactive 是审批/选择控件，仍回原消息处理；不给块坐标，避免被当成 HTML 预览。
      visit({ ...base, type: 'widget', name: b.title ?? b.description ?? 'Interactive' });
      return;
    default:
      return; // card / checklist 不收录
  }
}

function visitContentArtifacts(msg: AggregatorMessage, visit: ArtifactVisitor): void {
  for (const [index, block] of (msg.contentBlocks ?? []).entries()) {
    if (block.type !== 'image' && block.type !== 'file') continue;
    visit({
      catId: msg.catId,
      createdAt: msg.timestamp,
      sourceMessageId: msg.id,
      type:
        block.type === 'image'
          ? 'image'
          : projectFileContent({ name: block.fileName, url: block.url, mime: block.mimeType }).kind === 'video'
            ? 'video'
            : 'file',
      name: block.type === 'image' ? '图片' : block.fileName,
      url: block.url,
      ...(block.type === 'file' && block.mimeType ? { mime: block.mimeType } : {}),
      publicationItem: { kind: 'content-block', index },
    });
  }
}

function visitMessageArtifacts(messages: readonly AggregatorMessage[], visit: ArtifactVisitor): void {
  for (const msg of messages) {
    visitContentArtifacts(msg, visit);
    for (const b of msg.extra?.rich?.blocks ?? []) {
      visitBlockArtifacts(b, msg, visit);
    }
  }
}

export function projectMessageArtifacts(messages: readonly AggregatorMessage[]): ThreadArtifactDTO[] {
  const out: ThreadArtifactDTO[] = [];
  visitMessageArtifacts(messages, (artifact) => out.push(artifact));
  return out;
}

/** A single gallery cannot make one catalogue response or one F309 lookup unbounded. */
export function projectMessageArtifactSlice(message: AggregatorMessage, offset: number, limit: number) {
  const artifacts: ThreadArtifactDTO[] = [];
  let total = 0;
  visitMessageArtifacts([message], (artifact) => {
    if (total >= offset && artifacts.length < limit) artifacts.push(artifact);
    total += 1;
  });
  return { artifacts, total };
}

const RECENT_MESSAGE_ARTIFACT_TYPES = new Set<ThreadArtifactDTO['type']>(['image', 'video', 'file']);

function compareMessageRecentArtifacts(left: ThreadArtifactDTO, right: ThreadArtifactDTO): number {
  const leftPublication = left.publicationItem ? messageMediaItemKey(left.publicationItem) : '';
  const rightPublication = right.publicationItem ? messageMediaItemKey(right.publicationItem) : '';
  return (
    right.createdAt - left.createdAt ||
    (left.sourceMessageId ?? '').localeCompare(right.sourceMessageId ?? '') ||
    leftPublication.localeCompare(rightPublication) ||
    left.type.localeCompare(right.type) ||
    (left.ref ?? '').localeCompare(right.ref ?? '') ||
    (left.url ?? '').localeCompare(right.url ?? '') ||
    left.name.localeCompare(right.name) ||
    (left.catId ?? '').localeCompare(right.catId ?? '')
  );
}

function insertBoundedRecentArtifact(sorted: ThreadArtifactDTO[], artifact: ThreadArtifactDTO, limit: number): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareMessageRecentArtifacts(artifact, sorted[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  sorted.splice(low, 0, artifact);
  if (sorted.length > limit) sorted.pop();
}

export interface RecentMessageArtifactPage {
  artifacts: ThreadArtifactDTO[];
  total: number;
}

/** Count every admitted item while retaining only a bounded canonical prefix. */
export function projectRecentMessageArtifactPage(message: AggregatorMessage, limit: number): RecentMessageArtifactPage {
  const out: ThreadArtifactDTO[] = [];
  let total = 0;
  visitMessageArtifacts([message], (artifact) => {
    if (artifact.catId === null || !RECENT_MESSAGE_ARTIFACT_TYPES.has(artifact.type)) return;
    total += 1;
    insertBoundedRecentArtifact(out, artifact, limit);
  });
  return { artifacts: out, total };
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
    type: ledgerArtifactType(f),
    name: f.label,
    catId: f.updatedBy,
    createdAt: f.updatedAt,
    sourceMessageId: null,
    ref: f.ref,
    fileLedgerRef: f.ref,
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

export function aggregateProjectedThreadArtifacts(
  input: Omit<ThreadArtifactsAggregatorInput, 'messages'> & { messageArtifacts: ThreadArtifactDTO[] },
): ThreadArtifactDTO[] {
  const all = [
    ...input.messageArtifacts,
    ...prTasksToArtifacts(input.prTasks),
    ...fileLedgerToArtifacts(input.fileLedger),
  ];
  return dedupeByRef(all).sort((a, b) => b.createdAt - a.createdAt);
}

export function aggregateThreadArtifacts(input: ThreadArtifactsAggregatorInput): ThreadArtifactDTO[] {
  return aggregateProjectedThreadArtifacts({
    messageArtifacts: projectMessageArtifacts(input.messages),
    prTasks: input.prTasks,
    fileLedger: input.fileLedger,
  });
}
