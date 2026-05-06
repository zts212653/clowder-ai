import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { SqliteWorldStore } from '../../dist/domains/world/SqliteWorldStore.js';
import { WorldContextProvider } from '../../dist/domains/world/WorldContextProvider.js';
import { WorldKnowledgeAdapter } from '../../dist/domains/world/WorldKnowledgeAdapter.js';

const NOW = '2026-04-30T12:00:00Z';

describe('WorldContextProvider', () => {
  let worldStore;
  let evidenceStore;
  let provider;

  beforeEach(async () => {
    worldStore = new SqliteWorldStore(':memory:');
    await worldStore.initialize();
    evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize();
    const adapter = new WorldKnowledgeAdapter(evidenceStore);
    provider = new WorldContextProvider(worldStore, adapter);

    await worldStore.createWorld({
      worldId: 'w1',
      name: '逐峰宇宙',
      constitution: '时间是线性的',
      status: 'active',
      createdBy: { kind: 'user', id: 'you' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await worldStore.createScene({
      sceneId: 's1',
      worldId: 'w1',
      name: '第一幕',
      mode: 'build',
      status: 'active',
      activeCharacterIds: ['ch1'],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await worldStore.upsertCharacter({
      characterId: 'ch1',
      worldId: 'w1',
      coreIdentity: { name: 'A.W.', role: 'protagonist' },
      innerDrive: { motivation: '寻找真相' },
      relationshipTension: {
        bonds: [{ targetCharacterId: 'ch2', nature: 'rival', intensity: 70 }],
      },
      voiceAndImage: {},
      growthState: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(() => {
    worldStore.close();
    evidenceStore.close();
  });

  it('assembles a complete WorldContextEnvelope', async () => {
    const envelope = await provider.assemble('w1', 's1');
    assert.ok(envelope, 'should return envelope');
    assert.equal(envelope.world.name, '逐峰宇宙');
    assert.equal(envelope.scene.name, '第一幕');
    assert.equal(envelope.characters.length, 1);
    assert.equal(envelope.characters[0].coreIdentity.name, 'A.W.');
    assert.equal(envelope.relationshipSnapshot.length, 1);
    assert.equal(envelope.relationshipSnapshot[0].nature, 'rival');
    assert.deepEqual(envelope.recall, { canonMatches: [], eventMatches: [] });
    assert.equal(envelope.careLoopHint, undefined);
  });

  it('returns null for nonexistent world', async () => {
    const envelope = await provider.assemble('w999', 's1');
    assert.equal(envelope, null);
  });

  it('includes careLoopHint when provided', async () => {
    const hint = {
      trigger: '角色低落',
      suggestion: '问问铲屎官今天怎么样',
      realityBridge: '你是否也有类似的感受？',
    };
    const envelope = await provider.assemble('w1', 's1', { careLoopHint: hint });
    assert.ok(envelope);
    assert.deepEqual(envelope.careLoopHint, hint);
  });
});
