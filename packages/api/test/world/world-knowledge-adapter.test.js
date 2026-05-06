import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { WorldKnowledgeAdapter } from '../../dist/domains/world/WorldKnowledgeAdapter.js';

const NOW = '2026-04-30T12:00:00Z';

describe('WorldKnowledgeAdapter', () => {
  let evidenceStore;
  let adapter;

  beforeEach(async () => {
    evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize();
    adapter = new WorldKnowledgeAdapter(evidenceStore);
  });

  afterEach(() => {
    evidenceStore.close();
  });

  describe('indexCanon', () => {
    it('indexes accepted canon as evidence', async () => {
      await adapter.indexCanon(
        {
          recordId: 'canon-1',
          worldId: 'w1',
          sceneId: 's1',
          sourceEventId: 'evt-1',
          status: 'accepted',
          summary: 'A.W. 是黑客',
          category: 'character_trait',
          proposedBy: { kind: 'cat', id: 'opus' },
          decidedBy: { kind: 'user', id: 'you' },
          createdAt: NOW,
          decidedAt: NOW,
        },
        '逐峰宇宙',
      );

      const item = await evidenceStore.getByAnchor('world-canon-canon-1');
      assert.ok(item, 'evidence item should exist');
      assert.equal(item.title, '[逐峰宇宙] A.W. 是黑客');
      assert.equal(item.worldId, 'w1');
      assert.equal(item.sceneId, 's1');
    });

    it('skips non-accepted canon', async () => {
      await adapter.indexCanon(
        {
          recordId: 'canon-2',
          worldId: 'w1',
          sceneId: 's1',
          sourceEventId: 'evt-2',
          status: 'proposed',
          summary: 'not yet',
          proposedBy: { kind: 'cat', id: 'opus' },
          createdAt: NOW,
        },
        '逐峰宇宙',
      );

      const item = await evidenceStore.getByAnchor('world-canon-canon-2');
      assert.equal(item, null, 'should not index proposed canon');
    });
  });

  describe('searchWorld', () => {
    it('returns canon matches filtered by worldId', async () => {
      await adapter.indexCanon(
        {
          recordId: 'canon-1',
          worldId: 'w1',
          sceneId: 's1',
          sourceEventId: 'evt-1',
          status: 'accepted',
          summary: '时间穿越被禁止',
          category: 'world_rule',
          proposedBy: { kind: 'cat', id: 'opus' },
          decidedBy: { kind: 'user', id: 'you' },
          createdAt: NOW,
          decidedAt: NOW,
        },
        '逐峰宇宙',
      );
      await adapter.indexCanon(
        {
          recordId: 'canon-2',
          worldId: 'w2',
          sceneId: 's2',
          sourceEventId: 'evt-2',
          status: 'accepted',
          summary: '魔法允许穿越',
          category: 'world_rule',
          proposedBy: { kind: 'cat', id: 'opus' },
          decidedBy: { kind: 'user', id: 'you' },
          createdAt: NOW,
          decidedAt: NOW,
        },
        '平行世界',
      );

      const result = await adapter.searchWorld('穿越', { worldId: 'w1' });
      assert.equal(result.canonMatches.length, 1);
      assert.ok(result.canonMatches[0].summary.includes('时间穿越被禁止'));
    });
  });
});
