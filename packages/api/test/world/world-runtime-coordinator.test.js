import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteWorldStore } from '../../dist/domains/world/SqliteWorldStore.js';
import { WorldRuntimeCoordinator } from '../../dist/domains/world/WorldRuntimeCoordinator.js';

const NOW = '2026-04-30T12:00:00Z';
const actor = { kind: 'cat', id: 'opus', displayName: '宪宪' };

async function seedWorld(store) {
  await store.createWorld({
    worldId: 'w1',
    name: '逐峰宇宙',
    status: 'active',
    createdBy: actor,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsertCharacter({
    characterId: 'c1',
    worldId: 'w1',
    coreIdentity: { name: 'A.W.', description: '黑客' },
    innerDrive: { motivation: '真相' },
    relationshipTension: { bonds: [] },
    voiceAndImage: {},
    growthState: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.createScene({
    sceneId: 's1',
    worldId: 'w1',
    name: '深夜咖啡馆',
    mode: 'perform',
    status: 'active',
    activeCharacterIds: ['c1'],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeEnvelope(actions, overrides = {}) {
  return {
    worldId: 'w1',
    sceneId: 's1',
    actorCatId: 'opus',
    mode: 'perform',
    idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
    actions,
    ...overrides,
  };
}

describe('WorldRuntimeCoordinator', () => {
  let store;
  let coordinator;

  beforeEach(async () => {
    store = new SqliteWorldStore(':memory:');
    await store.initialize();
    coordinator = new WorldRuntimeCoordinator(store);
    await seedWorld(store);
  });

  afterEach(() => {
    store.close();
  });

  describe('perform_dialogue', () => {
    it('commits dialogue action and appends event', async () => {
      const envelope = makeEnvelope([{ type: 'perform_dialogue', characterId: 'c1', content: '你好世界' }]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].type, 'dialogue');

      const events = await store.getRecentEvents('w1', 's1');
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'dialogue');
      assert.deepEqual(events[0].payload, { content: '你好世界' });
      assert.equal(events[0].characterId, 'c1');
    });
  });

  describe('narrate', () => {
    it('commits narration action', async () => {
      const envelope = makeEnvelope([{ type: 'narrate', content: '夜幕降临' }]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'narration');

      const events = await store.getRecentEvents('w1', 's1');
      assert.deepEqual(events[0].payload, { content: '夜幕降临' });
    });
  });

  describe('batch actions', () => {
    it('commits multiple actions in one transaction', async () => {
      const envelope = makeEnvelope([
        { type: 'perform_dialogue', characterId: 'c1', content: '你好' },
        { type: 'narrate', content: '他笑了' },
      ]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events.length, 2);

      const events = await store.getRecentEvents('w1', 's1');
      assert.equal(events.length, 2);
    });
  });

  describe('validation', () => {
    it('rejects invalid worldId', async () => {
      const envelope = makeEnvelope([{ type: 'narrate', content: 'test' }], { worldId: 'nonexistent' });
      await assert.rejects(() => coordinator.execute(envelope), /world not found/i);
    });

    it('rejects invalid sceneId', async () => {
      const envelope = makeEnvelope([{ type: 'narrate', content: 'test' }], { sceneId: 'nonexistent' });
      await assert.rejects(() => coordinator.execute(envelope), /scene not found/i);
    });
  });

  describe('idempotency', () => {
    it('duplicate idempotencyKey does not double-append', async () => {
      const envelope = makeEnvelope([{ type: 'narrate', content: 'once' }], { idempotencyKey: 'idem-fixed' });
      await coordinator.execute(envelope);
      await coordinator.execute(envelope);

      const events = await store.getRecentEvents('w1', 's1');
      assert.equal(events.length, 1);
    });
  });

  describe('propose_canon', () => {
    it('creates proposed CanonPromotionRecord', async () => {
      // Seed an event first to reference
      await store.appendEvent({
        eventId: 'evt-seed',
        worldId: 'w1',
        sceneId: 's1',
        type: 'dialogue',
        actor,
        payload: { content: 'seed' },
        createdAt: NOW,
      });

      const envelope = makeEnvelope([
        { type: 'propose_canon', sourceEventId: 'evt-seed', summary: 'A.W. 是黑客', category: 'character_trait' },
      ]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'canon_proposed');

      const canonId = result.events[0].canonRecordId;
      assert.ok(canonId, 'should have canonRecordId');
      const record = await store.getCanonRecord(canonId);
      assert.equal(record.status, 'proposed');
      assert.equal(record.summary, 'A.W. 是黑客');
    });

    it('auto-links sourceEventId when omitted (cloud P2)', async () => {
      const envelope = makeEnvelope([{ type: 'propose_canon', summary: '时间只能前进' }]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'canon_proposed');
      const canonId = result.events[0].canonRecordId;
      const record = await store.getCanonRecord(canonId);
      assert.ok(record.sourceEventId, 'should have auto-linked sourceEventId');
    });
  });

  describe('decide_canon', () => {
    it('accepts canon and appends canon_accepted event', async () => {
      // Create a proposed canon record first
      await store.createCanonRecord({
        recordId: 'canon-1',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-1',
        status: 'proposed',
        summary: '世界规则',
        proposedBy: actor,
        createdAt: NOW,
      });

      const envelope = makeEnvelope([
        { type: 'decide_canon', recordId: 'canon-1', decision: 'accepted', reason: '符合世界观' },
      ]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'canon_accepted');

      const record = await store.getCanonRecord('canon-1');
      assert.equal(record.status, 'accepted');
      assert.equal(record.reason, '符合世界观');
    });

    it('rejects canon and appends canon_rejected event', async () => {
      await store.createCanonRecord({
        recordId: 'canon-2',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-2',
        status: 'proposed',
        summary: '不合适',
        proposedBy: actor,
        createdAt: NOW,
      });

      const envelope = makeEnvelope([{ type: 'decide_canon', recordId: 'canon-2', decision: 'rejected' }]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'canon_rejected');

      const record = await store.getCanonRecord('canon-2');
      assert.equal(record.status, 'rejected');
    });
  });

  describe('update_character_state', () => {
    it('applies JSON patch to character state slot', async () => {
      const envelope = makeEnvelope([
        {
          type: 'update_character_state',
          characterId: 'c1',
          slot: 'growthState',
          patch: [{ op: 'add', path: '/currentArc', value: '觉醒篇' }],
        },
      ]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'character_state_change');

      const char = await store.getCharacter('c1');
      assert.equal(char.growthState.currentArc, '觉醒篇');
    });
  });

  describe('edit_character_definition (build mode)', () => {
    it('applies definition edit in build mode', async () => {
      // Update scene to build mode
      await store.updateSceneStatus('s1', 'active', NOW);
      await store.createScene({
        sceneId: 's-build',
        worldId: 'w1',
        name: 'Build Session',
        mode: 'build',
        status: 'active',
        activeCharacterIds: ['c1'],
        createdAt: NOW,
        updatedAt: NOW,
      });

      const envelope = makeEnvelope(
        [
          {
            type: 'edit_character_definition',
            characterId: 'c1',
            slot: 'coreIdentity',
            patch: [{ op: 'replace', path: '/description', value: '进化的黑客' }],
          },
        ],
        { sceneId: 's-build', mode: 'build' },
      );
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'character_definition_change');

      const char = await store.getCharacter('c1');
      assert.equal(char.coreIdentity.description, '进化的黑客');
    });
  });

  describe('transition_scene', () => {
    it('creates scene transition event', async () => {
      const envelope = makeEnvelope([
        { type: 'transition_scene', newSceneName: '雨中追逐', newSceneDescription: '暴雨街道' },
      ]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'scene_transition');
    });
  });

  describe('care_check_in', () => {
    it('creates care check-in event', async () => {
      const envelope = makeEnvelope([
        { type: 'care_check_in', suggestion: '喝杯水', realityBridge: '今天走了多少步？' },
      ]);
      const result = await coordinator.execute(envelope);
      assert.equal(result.events[0].type, 'care_check_in');
      assert.deepEqual(result.events[0].payload, { suggestion: '喝杯水', realityBridge: '今天走了多少步？' });
    });
  });

  describe('cross-world validation (P1-3)', () => {
    it('rejects scene that belongs to a different world', async () => {
      await store.createWorld({
        worldId: 'w2',
        name: '另一个世界',
        status: 'active',
        createdBy: actor,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await store.createScene({
        sceneId: 's2',
        worldId: 'w2',
        name: '别的场景',
        mode: 'build',
        status: 'active',
        activeCharacterIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const envelope = makeEnvelope([{ type: 'narrate', content: 'cross-world attack' }], {
        worldId: 'w1',
        sceneId: 's2',
      });
      await assert.rejects(() => coordinator.execute(envelope), /does not belong to world/i);
    });

    it('rejects character mutation targeting a different world', async () => {
      await store.createWorld({
        worldId: 'w2',
        name: '另一个世界',
        status: 'active',
        createdBy: actor,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await store.upsertCharacter({
        characterId: 'c-other',
        worldId: 'w2',
        coreIdentity: { name: 'Intruder' },
        innerDrive: {},
        relationshipTension: { bonds: [] },
        voiceAndImage: {},
        growthState: {},
        createdAt: NOW,
        updatedAt: NOW,
      });
      const envelope = makeEnvelope([
        {
          type: 'update_character_state',
          characterId: 'c-other',
          slot: 'growthState',
          patch: [{ op: 'add', path: '/hacked', value: true }],
        },
      ]);
      await assert.rejects(() => coordinator.execute(envelope), /does not belong to world/i);
    });

    it('rejects decide_canon targeting a different world', async () => {
      await store.createWorld({
        worldId: 'w2',
        name: '另一个世界',
        status: 'active',
        createdBy: actor,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await store.createCanonRecord({
        recordId: 'canon-other',
        worldId: 'w2',
        sceneId: 's-other',
        sourceEventId: 'evt-other',
        status: 'proposed',
        summary: '别的世界的规则',
        proposedBy: actor,
        createdAt: NOW,
      });
      const envelope = makeEnvelope([
        { type: 'decide_canon', recordId: 'canon-other', decision: 'accepted', reason: 'cross-world attack' },
      ]);
      await assert.rejects(() => coordinator.execute(envelope), /does not belong to world/i);
    });
  });

  describe('mode boundary (P1-4)', () => {
    it('rejects edit_character_definition in perform mode', async () => {
      const envelope = makeEnvelope(
        [
          {
            type: 'edit_character_definition',
            characterId: 'c1',
            slot: 'coreIdentity',
            patch: [{ op: 'replace', path: '/name', value: 'Hacked' }],
          },
        ],
        { mode: 'perform' },
      );
      const result = await coordinator.execute(envelope);
      assert.ok(result.errors?.length > 0, 'should return errors');
      assert.equal(result.events.length, 0, 'no events should be committed');
      assert.ok(result.errors[0].includes('not allowed'));
    });

    it('rejects all actions in replay mode', async () => {
      const envelope = makeEnvelope([{ type: 'narrate', content: 'cannot write in replay' }], { mode: 'replay' });
      const result = await coordinator.execute(envelope);
      assert.ok(result.errors?.length > 0);
      assert.equal(result.events.length, 0);
    });

    it('allows narrate in build mode', async () => {
      await store.createScene({
        sceneId: 's-build',
        worldId: 'w1',
        name: 'Build',
        mode: 'build',
        status: 'active',
        activeCharacterIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const envelope = makeEnvelope([{ type: 'narrate', content: 'building the world' }], {
        sceneId: 's-build',
        mode: 'build',
      });
      const result = await coordinator.execute(envelope);
      assert.equal(result.events.length, 1);
      assert.equal(result.errors, undefined);
    });
  });

  describe('mode mismatch (P1-B)', () => {
    it('rejects envelope.mode that does not match scene.mode', async () => {
      // scene s1 is in 'perform' mode (from seedWorld)
      // client sends envelope with mode='build' to bypass restriction
      const envelope = makeEnvelope(
        [
          {
            type: 'edit_character_definition',
            characterId: 'c1',
            slot: 'coreIdentity',
            patch: [{ op: 'replace', path: '/name', value: 'Bypassed' }],
          },
        ],
        { mode: 'build' },
      );
      const result = await coordinator.execute(envelope);
      assert.ok(result.errors?.length > 0, 'should reject mode mismatch');
      assert.equal(result.events.length, 0);
    });

    it('uses scene.mode as authoritative source, not envelope', async () => {
      // scene s1 is perform, envelope claims build → should use perform rules
      const envelope = makeEnvelope([{ type: 'narrate', content: 'test' }], { mode: 'build' });
      const result = await coordinator.execute(envelope);
      // narrate is allowed in both build and perform, but mode mismatch should still reject
      assert.ok(result.errors?.length > 0, 'mode mismatch should be rejected even for allowed actions');
    });
  });

  describe('idempotency key scoping (cloud P1)', () => {
    it('same key in different scenes is NOT treated as duplicate', async () => {
      await store.createScene({
        sceneId: 's2',
        worldId: 'w1',
        name: '第二幕',
        mode: 'perform',
        status: 'active',
        activeCharacterIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      });

      const key = 'shared-key-1';
      const r1 = await coordinator.execute(
        makeEnvelope([{ type: 'narrate', content: '第一幕旁白' }], { idempotencyKey: key, sceneId: 's1' }),
      );
      assert.equal(r1.events.length, 1, 'first scene should produce events');

      const r2 = await coordinator.execute(
        makeEnvelope([{ type: 'narrate', content: '第二幕旁白' }], { idempotencyKey: key, sceneId: 's2' }),
      );
      assert.equal(r2.events.length, 1, 'same key in different scene should NOT be deduped');
    });
  });
});
