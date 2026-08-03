import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { DiaryEvidenceProjector } from '../dist/domains/auto-dream/DiaryEvidenceProjector.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const THREAD = 'thread-present-loop';

describe('DiaryEvidenceProjector', () => {
  let productStore;
  let evidenceStore;

  beforeEach(async () => {
    productStore = new AutoDreamStore(':memory:');
    evidenceStore = new SqliteEvidenceStore(':memory:');
    await productStore.initialize();
    await evidenceStore.initialize();
  });

  afterEach(() => {
    productStore.close();
    evidenceStore.close();
  });

  async function writeDiary(bodyMarkdown = '我在窗边看见一只荧光海豚游过去，暗号 PHOSPHOR_DOLPHIN。') {
    const begun = await productStore.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: THREAD,
      taskId: `present-loop-${Date.now()}-${Math.random()}`,
      firedAt: Date.now(),
    });
    return productStore.settleRun(
      {
        kind: 'invocation',
        invocationId: `inv-${Math.random()}`,
        userId: OWNER,
        catId: CAT,
        threadId: THREAD,
      },
      {
        runId: begun.run.runId,
        outcome: 'diary',
        diary: {
          entryKind: 'souvenir',
          traceKind: 'non_work',
          localDate: '2026-07-16',
          headline: '窗边的访客',
          summary: '这是某天的现场记录。',
          bodyMarkdown,
          provenance: [
            {
              kind: 'thread_message',
              refId: 'message:source',
              threadId: THREAD,
              messageId: 'message-source',
            },
          ],
        },
      },
    );
  }

  test('projects a published diary as historical private evidence with raw body and drill-down', async () => {
    const settled = await writeDiary();
    const projector = new DiaryEvidenceProjector(productStore, evidenceStore, OWNER);
    const result = await projector.reconcile(OWNER);
    assert.deepEqual(result, { projected: 1, removed: 0, failed: 0 });

    const anchor = `diary:${settled.diary.diaryId}`;
    const item = await evidenceStore.getByAnchor(anchor);
    assert.equal(item?.kind, 'diary');
    assert.equal(item?.status, 'historical');
    assert.match(item?.summary ?? '', /现场记录未清洗/);

    const bodyHit = await evidenceStore.search('PHOSPHOR_DOLPHIN', { mode: 'lexical', depth: 'raw' });
    assert.equal(bodyHit[0]?.anchor, anchor);
    assert.match(bodyHit[0]?.passages?.[0]?.content ?? '', /荧光海豚/);
    assert.deepEqual(bodyHit[0]?.drillDown, {
      tool: 'cat_cafe_read_diary',
      params: { diaryId: settled.diary.diaryId },
      hint: '读取这篇第一人称日记原文与 provenance',
    });
    assert.equal((await productStore.listProjectionCandidates(OWNER)).length, 0);
  });

  test('keeps the product diary canonical across an index crash and repairs it on retry', async () => {
    const settled = await writeDiary('只有产品表先写成功。');
    const failingEvidenceStore = {
      upsert: async () => {
        throw new Error('synthetic index crash');
      },
      deleteByAnchor: evidenceStore.deleteByAnchor.bind(evidenceStore),
      getDb: evidenceStore.getDb.bind(evidenceStore),
      runExclusive: evidenceStore.runExclusive.bind(evidenceStore),
      refreshEntityMentions: evidenceStore.refreshEntityMentions.bind(evidenceStore),
    };

    const failed = await new DiaryEvidenceProjector(productStore, failingEvidenceStore, OWNER).reconcile(OWNER);
    assert.deepEqual(failed, { projected: 0, removed: 0, failed: 1 });
    assert.equal((await productStore.getDiary(OWNER, settled.diary.diaryId))?.status, 'published');
    assert.equal((await productStore.listProjectionCandidates(OWNER)).length, 1);

    const repaired = await new DiaryEvidenceProjector(productStore, evidenceStore, OWNER).reconcile(OWNER);
    assert.deepEqual(repaired, { projected: 1, removed: 0, failed: 0 });
    assert.equal((await productStore.listProjectionCandidates(OWNER)).length, 0);
  });

  test('removes an archived diary projection without deleting the product artifact', async () => {
    const settled = await writeDiary();
    const projector = new DiaryEvidenceProjector(productStore, evidenceStore, OWNER);
    await projector.reconcile(OWNER);
    await productStore.archiveDiary(OWNER, settled.diary.diaryId);

    const result = await projector.reconcile(OWNER);
    assert.deepEqual(result, { projected: 0, removed: 1, failed: 0 });
    assert.equal(await evidenceStore.getByAnchor(`diary:${settled.diary.diaryId}`), null);
    assert.equal((await productStore.getDiary(OWNER, settled.diary.diaryId))?.status, 'archived');
  });

  test('fails closed before projecting a different owner into the configured private collection', async () => {
    const projector = new DiaryEvidenceProjector(productStore, evidenceStore, OWNER);
    await assert.rejects(() => projector.reconcile('owner-b'), /configured private owner/);
  });
});
