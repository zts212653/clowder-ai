import type Database from 'better-sqlite3';
import type { EvidenceItem, IEvidenceStore } from '../memory/interfaces.js';
import type { AutoDreamStore } from './AutoDreamStore.js';
import type { DreamDiaryEntryRecord } from './store-types.js';

interface DiaryEvidenceStore extends Pick<IEvidenceStore, 'upsert' | 'deleteByAnchor'> {
  getDb(): Database.Database;
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  refreshEntityMentions?(docAnchors?: string[]): Promise<void>;
}

export interface DiaryProjectionResult {
  projected: number;
  removed: number;
  failed: number;
}

const RAW_WARNING = '现场记录未清洗';
const BODY_PASSAGE_ID = 'diary-body-v1';

export class DiaryEvidenceProjector {
  constructor(
    private readonly productStore: AutoDreamStore,
    private readonly evidenceStore: DiaryEvidenceStore,
    private readonly privateOwnerUserId: string,
  ) {}

  async reconcile(ownerUserId: string, limit = 100): Promise<DiaryProjectionResult> {
    if (ownerUserId !== this.privateOwnerUserId) {
      throw new Error('diary projection owner does not match the configured private owner');
    }
    const result: DiaryProjectionResult = { projected: 0, removed: 0, failed: 0 };
    const candidates = await this.productStore.listProjectionCandidates(ownerUserId, limit);
    for (const candidate of candidates) {
      try {
        const removed = candidate.diary.status === 'archived' || candidate.diary.sealedAt !== undefined;
        if (removed) {
          await this.evidenceStore.deleteByAnchor(diaryAnchor(candidate.diary.diaryId));
        } else {
          await this.project(candidate.diary);
        }
        const committed = await this.productStore.markDiaryProjected(
          ownerUserId,
          candidate.diary.diaryId,
          candidate.diary.revision,
        );
        if (!committed) throw new Error('product revision changed during diary projection');
        if (removed) result.removed += 1;
        else result.projected += 1;
      } catch (error) {
        result.failed += 1;
        await this.productStore.markDiaryProjectionFailed(
          ownerUserId,
          candidate.diary.diaryId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return result;
  }

  private async project(diary: DreamDiaryEntryRecord): Promise<void> {
    const anchor = diaryAnchor(diary.diaryId);
    await this.evidenceStore.upsert([toEvidenceItem(diary)]);
    const db = this.evidenceStore.getDb();
    const replacePassage = db.transaction(() => {
      db.prepare('DELETE FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?').run(anchor, BODY_PASSAGE_ID);
      db.prepare(
        `INSERT INTO evidence_passages (
           doc_anchor, passage_id, content, speaker, position, created_at
         ) VALUES (?, ?, ?, ?, 0, ?)`,
      ).run(
        anchor,
        BODY_PASSAGE_ID,
        `【${RAW_WARNING}】\n${diary.bodyMarkdown}`,
        diary.catId,
        new Date(diary.writtenAt).toISOString(),
      );
    });
    await this.evidenceStore.runExclusive(replacePassage);
    await this.evidenceStore.refreshEntityMentions?.([anchor]);
  }
}

function diaryAnchor(diaryId: string): string {
  return `diary:${diaryId}`;
}

function toEvidenceItem(diary: DreamDiaryEntryRecord): EvidenceItem {
  return {
    anchor: diaryAnchor(diary.diaryId),
    kind: 'diary',
    status: 'historical',
    title: diary.headline,
    summary: `【${RAW_WARNING} · ${diary.localDate} · ${diary.catId} · 卷 ${diary.volumeNo}】${diary.summary}`,
    keywords: ['diary', diary.entryKind, diary.traceKind, diary.catId, diary.localDate],
    sourcePath: `cat-cafe-diary://${diary.diaryId}`,
    updatedAt: new Date(diary.updatedAt).toISOString(),
    drillDown: {
      tool: 'cat_cafe_read_diary',
      params: { diaryId: diary.diaryId },
      hint: '读取这篇第一人称日记原文与 provenance',
    },
    authority: 'observed',
    activation: 'query',
    provenance: { tier: 'authoritative', source: `auto-dream:${diary.diaryId}` },
    generalizable: false,
  };
}
