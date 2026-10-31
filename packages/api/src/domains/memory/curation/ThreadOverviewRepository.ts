import type { CatId } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { canViewMessage } from '../../cats/services/stores/visibility.js';
import { canAccessThread } from '../../guides/guide-state-access.js';
import { buildSearchableMessageContent } from '../message-search-content.js';
import { readRecallSuppressionFence } from '../summary-compaction-effects.js';
import { isCurationMessageReadable } from './curation-message-visibility.js';
import { isCanonicalThreadOverview, overviewRevision, overviewSourceIds } from './LunaCurationState.js';

export interface ThreadOverview {
  threadId: string;
  title: string;
  summary: string;
  revision: string;
  directoryLine: string;
  sources: Array<{ threadId: string; messageId: string }>;
  legacy: boolean;
}
export interface ThreadDirectory {
  entries: Array<{ threadId: string; revision: string; line: string; coverage: 'overview' | 'legacy' | 'missing' }>;
  coverage: { readable: number; overview: number; legacy: number; missing: number };
}
interface EvidenceRow {
  title: string;
  summary: string | null;
  directoryLine: string | null;
  revision: string | null;
}

/** Projection over F102; permission is evaluated before material enters either model. */
export class ThreadOverviewRepository {
  constructor(
    readonly deps: {
      db: Database.Database;
      ownerUserId: string;
      threadStore: Pick<IThreadStore, 'list' | 'get'>;
      messageStore: Pick<
        IMessageStore,
        'getById' | 'getByThread' | 'getByThreadAfter' | 'canonicalizeCursor' | 'getLatestVisibleCursor'
      >;
    },
  ) {}

  async isSourceReadable(threadId: string, messageId: string, consumerCatId?: string) {
    if (readRecallSuppressionFence(this.deps.db, threadId).preparedCount) return false;
    const message = await this.deps.messageStore.getById(messageId);
    return Boolean(
      message &&
        isCurationMessageReadable(message, this.deps.ownerUserId, threadId) &&
        (consumerCatId ? canViewMessage(message, { type: 'cat', catId: consumerCatId as CatId }) : true),
    );
  }

  async directory(
    ownerUserId: string,
    consumerCatId: string,
    excludeThreadId?: string,
    signal?: AbortSignal,
  ): Promise<ThreadDirectory> {
    signal?.throwIfAborted();
    const result: ThreadDirectory = { entries: [], coverage: { readable: 0, overview: 0, legacy: 0, missing: 0 } };
    if (ownerUserId !== this.deps.ownerUserId) return result;
    const threads = await this.deps.threadStore.list(ownerUserId);
    for (const thread of [...threads].sort((a, b) => a.id.localeCompare(b.id))) {
      signal?.throwIfAborted();
      if (
        !canAccessThread(thread, ownerUserId) ||
        thread.deletedAt ||
        thread.systemKind ||
        thread.id === excludeThreadId
      )
        continue;
      result.coverage.readable++;
      const row = this.row(thread.id);
      const ids = overviewSourceIds(row?.summary ?? null, thread.id);
      const suppressed = readRecallSuppressionFence(this.deps.db, thread.id).preparedCount > 0;
      const valid =
        !suppressed &&
        this.isCanonicalOverview(thread.id, row) &&
        ids.length > 0 &&
        (await Promise.all(ids.map((id) => this.isSourceReadable(thread.id, id, consumerCatId)))).every(Boolean);
      signal?.throwIfAborted();
      const coverage = valid ? 'overview' : row?.summary ? 'legacy' : 'missing';
      result.coverage[coverage]++;
      // Historical summaries without per-claim provenance are discoverable by title until the resumable backfill.
      // Never send their potentially private/unattributed body to a model as directory context.
      result.entries.push({
        threadId: thread.id,
        revision: overviewRevision(valid ? row!.summary : (thread.title ?? '')),
        line: valid
          ? row?.directoryLine || row?.title || thread.title || thread.id
          : [thread.title || thread.id, suppressed ? '' : await this.legacyPreview(thread.id, row?.summary ?? null)]
              .filter(Boolean)
              .join('：'),
        coverage,
      });
      signal?.throwIfAborted();
    }
    return result;
  }

  async read(
    ownerUserId: string,
    consumerCatId: string,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ThreadOverview | null> {
    signal?.throwIfAborted();
    if (ownerUserId !== this.deps.ownerUserId) return null;
    const thread = await this.deps.threadStore.get(threadId);
    signal?.throwIfAborted();
    if (!thread || !canAccessThread(thread, ownerUserId) || thread.deletedAt || thread.systemKind) return null;
    const fence = readRecallSuppressionFence(this.deps.db, threadId);
    if (fence.preparedCount) return null;
    const row = this.row(threadId);
    const ids = overviewSourceIds(row?.summary ?? null, threadId);
    if (row?.summary && ids.length > 0 && this.isCanonicalOverview(threadId, row)) {
      if (!(await Promise.all(ids.map((id) => this.isSourceReadable(threadId, id, consumerCatId)))).every(Boolean))
        return null;
      signal?.throwIfAborted();
      const current = this.row(threadId);
      if (current?.summary !== row.summary) return null;
      return {
        threadId,
        title: row.title,
        summary: row.summary,
        revision: overviewRevision(row.summary),
        directoryLine: row.directoryLine ?? row.title,
        sources: ids.map((messageId) => ({ threadId, messageId })),
        legacy: false,
      };
    }
    // Bootstrap a readable projection from actual historical messages. The legacy summary remains a hint,
    // never evidence. No private body is imported through an old un-attributed summary.
    const messages = await this.deps.messageStore.getByThread(threadId, 100, ownerUserId);
    signal?.throwIfAborted();
    const readable = messages.filter(
      (m) =>
        isCurationMessageReadable(m, ownerUserId, threadId) &&
        canViewMessage(m, { type: 'cat', catId: consumerCatId as CatId }),
    );
    if (!readable.length) return null;
    const summary = readable.map((m) => `${buildSearchableMessageContent(m)} （来源：${threadId}#${m.id}）`).join('\n');
    return {
      threadId,
      title: thread.title || row?.title || thread.id,
      summary,
      revision: overviewRevision(summary),
      directoryLine: thread.title || row?.title || thread.id,
      sources: readable.map((m) => ({ threadId, messageId: m.id })),
      legacy: true,
    };
  }

  private async legacyPreview(threadId: string, summary: string | null): Promise<string> {
    if (!summary) return '';
    const messages = await this.deps.messageStore.getByThread(threadId, 100, this.deps.ownerUserId);
    if (messages.some((m) => !isCurationMessageReadable(m, this.deps.ownerUserId, threadId))) return '';
    const original = messages.map((m) => `[${m.catId ?? 'user'}] ${buildSearchableMessageContent(m)}`).join('\n');
    const prefix = summary.endsWith('...') ? summary.slice(0, -3) : summary;
    // Only reuse a legacy concatenation whose exact source material still exists publicly.
    if (!original.startsWith(prefix)) return '';
    return prefix.replace(/\s+/g, ' ').slice(0, 80);
  }

  private isCanonicalOverview(threadId: string, row: EvidenceRow | undefined): boolean {
    return isCanonicalThreadOverview(this.deps.db, this.deps.ownerUserId, threadId, row?.summary ?? null);
  }

  private row(threadId: string) {
    return this.deps.db
      .prepare(`SELECT d.title,d.summary,s.directory_line AS directoryLine,s.summary_revision AS revision
      FROM evidence_docs d LEFT JOIN thread_curation_state s ON s.thread_id=? AND s.owner_user_id=?
      WHERE d.anchor=? AND d.kind='thread'`)
      .get(threadId, this.deps.ownerUserId, `thread-${threadId}`) as EvidenceRow | undefined;
  }
}
