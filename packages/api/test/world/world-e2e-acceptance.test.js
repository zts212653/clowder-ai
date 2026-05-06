import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { CareLoopEvaluator } from '../../dist/domains/world/CareLoopEvaluator.js';
import { SqliteWorldStore } from '../../dist/domains/world/SqliteWorldStore.js';
import { WorldContextProvider } from '../../dist/domains/world/WorldContextProvider.js';
import { WorldDriverBridge } from '../../dist/domains/world/WorldDriverBridge.js';
import { WorldKnowledgeAdapter } from '../../dist/domains/world/WorldKnowledgeAdapter.js';
import { WorldRuntimeCoordinator } from '../../dist/domains/world/WorldRuntimeCoordinator.js';

const NOW = '2026-04-30T12:00:00Z';

describe('F093 Phase A — End-to-End Acceptance (AC-A10)', () => {
  let worldStore;
  let evidenceStore;
  let coordinator;
  let adapter;
  let bridge;
  let evaluator;

  beforeEach(async () => {
    worldStore = new SqliteWorldStore(':memory:');
    await worldStore.initialize();
    evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize();

    coordinator = new WorldRuntimeCoordinator(worldStore);
    adapter = new WorldKnowledgeAdapter(evidenceStore);
    const contextProvider = new WorldContextProvider(worldStore, adapter);
    bridge = new WorldDriverBridge(
      {
        resolver: 'hybrid',
        actions: [
          'perform_dialogue',
          'narrate',
          'propose_canon',
          'decide_canon',
          'edit_character_definition',
          'update_character_state',
          'care_check_in',
          'transition_scene',
        ],
      },
      coordinator,
      contextProvider,
    );
    evaluator = new CareLoopEvaluator({ minEventsBetweenChecks: 3 });
  });

  afterEach(() => {
    worldStore.close();
    evidenceStore.close();
  });

  it('full world lifecycle: create → character → scene → action → canon → recall → replay', async () => {
    // 1. Create world
    await worldStore.createWorld({
      worldId: 'w1',
      name: '逐峰宇宙',
      constitution: '时间是线性的，因果不可逆',
      status: 'active',
      createdBy: { kind: 'user', id: 'you' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const world = await worldStore.getWorld('w1');
    assert.ok(world, 'world should exist');
    assert.equal(world.name, '逐峰宇宙');

    // 2. Create character with 5 slots
    await worldStore.upsertCharacter({
      characterId: 'ch1',
      worldId: 'w1',
      coreIdentity: { name: 'A.W.', role: 'protagonist' },
      innerDrive: { motivation: '寻找真相', fear: '被遗忘' },
      relationshipTension: {
        bonds: [{ targetCharacterId: 'ch2', nature: 'rival', intensity: 70 }],
      },
      voiceAndImage: { voiceStyle: 'cold and precise' },
      growthState: { phase: 'awakening', progress: 10 },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const ch = await worldStore.getCharacter('ch1');
    assert.ok(ch, 'character should exist');
    assert.equal(ch.coreIdentity.name, 'A.W.');
    assert.equal(ch.innerDrive.motivation, '寻找真相');
    assert.equal(ch.relationshipTension.bonds[0].nature, 'rival');
    assert.equal(ch.voiceAndImage.voiceStyle, 'cold and precise');
    assert.equal(ch.growthState.phase, 'awakening');

    // 3. Create scene
    await worldStore.createScene({
      sceneId: 's1',
      worldId: 'w1',
      name: '第一幕：觉醒',
      mode: 'build',
      status: 'active',
      activeCharacterIds: ['ch1'],
      createdAt: NOW,
      updatedAt: NOW,
    });

    // 4. Submit actions via bridge
    const r1 = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'narrate', content: '夜幕降临，逐峰世界苏醒' }],
      idempotencyKey: 'k1',
    });
    assert.equal(r1.events.length, 1);
    assert.equal(r1.events[0].type, 'narration');

    const r2 = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'perform_dialogue', characterId: 'ch1', content: '我记得……这不是第一次' }],
      idempotencyKey: 'k2',
    });
    assert.equal(r2.events.length, 1);
    assert.equal(r2.events[0].type, 'dialogue');

    // 5. Propose + accept canon
    const r3 = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'propose_canon', summary: '时间穿越被禁止', category: 'world_rule' }],
      idempotencyKey: 'k3',
    });
    assert.equal(r3.events[0].type, 'canon_proposed');
    const canonRecordId = r3.events[0].canonRecordId;
    assert.ok(canonRecordId);

    const r4 = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'decide_canon', recordId: canonRecordId, decision: 'accepted', reason: '全票通过' }],
      idempotencyKey: 'k4',
    });
    assert.equal(r4.events[0].type, 'canon_accepted');

    // Verify canon in store
    const canon = await worldStore.getCanonRecord(canonRecordId);
    assert.equal(canon.status, 'accepted');
    assert.equal(canon.summary, '时间穿越被禁止');

    // 6. Index canon into evidence + search world-scoped recall
    await adapter.indexCanon(canon, '逐峰宇宙');
    const recall = await adapter.searchWorld('穿越', { worldId: 'w1' });
    assert.equal(recall.canonMatches.length, 1);
    assert.ok(recall.canonMatches[0].summary.includes('时间穿越被禁止'));

    // 7. Replay event log
    const events = await worldStore.getRecentEvents('w1', 's1', 50);
    assert.equal(events.length, 4);
    assert.equal(events[0].type, 'narration');
    assert.equal(events[1].type, 'dialogue');
    assert.equal(events[2].type, 'canon_proposed');
    assert.equal(events[3].type, 'canon_accepted');

    // 8. WorldContextEnvelope assembly
    const envelope = await bridge.getContext('w1', 's1');
    assert.ok(envelope);
    assert.equal(envelope.world.name, '逐峰宇宙');
    assert.equal(envelope.characters.length, 1);
    assert.equal(envelope.recentEvents.length, 4);
    assert.equal(envelope.canonSummary.length, 1);
    assert.equal(envelope.relationshipSnapshot.length, 1);

    // 9. CareLoopEvaluator
    const hint = evaluator.evaluate(events, [ch]);
    assert.equal(hint, undefined, 'no trigger keyword in these events');

    // 10. Idempotency — re-executing same key returns empty
    const r5 = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'narrate', content: 'duplicate' }],
      idempotencyKey: 'k1',
    });
    assert.equal(r5.events.length, 0, 'idempotent replay should return 0 events');
  });
});
