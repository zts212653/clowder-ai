import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CanonPromotionRecord,
  CanonPromotionRecordSchema,
  type CharacterRecord,
  CharacterRecordSchema,
  SceneRecordSchema,
  SceneStatusSchema,
  type WorldActionEnvelope,
  WorldActionEnvelopeSchema,
  WorldActorRefSchema,
  WorldContextEnvelopeSchema,
  WorldEventEntrySchema,
  WorldModeSchema,
  type WorldRecord,
  WorldRecordSchema,
  WorldStatusSchema,
} from '../schemas/world.js';

const NOW = '2026-04-30T12:00:00Z';
const actor = { kind: 'cat' as const, id: 'opus', displayName: '宪宪' };

describe('F093 World Contracts — Schemas', () => {
  describe('enum schemas', () => {
    it('accepts valid WorldStatus values', () => {
      for (const v of ['draft', 'active', 'archived']) {
        assert.equal(WorldStatusSchema.parse(v), v);
      }
    });

    it('rejects invalid WorldStatus', () => {
      assert.throws(() => WorldStatusSchema.parse('deleted'));
    });

    it('accepts valid WorldMode values', () => {
      for (const v of ['build', 'perform', 'replay']) {
        assert.equal(WorldModeSchema.parse(v), v);
      }
    });

    it('accepts valid SceneStatus values', () => {
      for (const v of ['draft', 'active', 'completed']) {
        assert.equal(SceneStatusSchema.parse(v), v);
      }
    });
  });

  describe('WorldActorRef', () => {
    it('accepts user actor', () => {
      const ref = WorldActorRefSchema.parse({ kind: 'user', id: 'u1' });
      assert.equal(ref.kind, 'user');
    });

    it('accepts cat actor with displayName', () => {
      const ref = WorldActorRefSchema.parse(actor);
      assert.equal(ref.displayName, '宪宪');
    });

    it('accepts system actor', () => {
      const ref = WorldActorRefSchema.parse({ kind: 'system', id: 'coordinator' });
      assert.equal(ref.kind, 'system');
    });

    it('rejects invalid kind', () => {
      assert.throws(() => WorldActorRefSchema.parse({ kind: 'bot', id: 'x' }));
    });
  });

  describe('WorldRecord', () => {
    it('accepts minimal world', () => {
      const w: WorldRecord = WorldRecordSchema.parse({
        worldId: 'w1',
        name: '逐峰宇宙',
        status: 'draft',
        createdBy: actor,
        createdAt: NOW,
        updatedAt: NOW,
      });
      assert.equal(w.worldId, 'w1');
      assert.equal(w.constitution, undefined);
    });

    it('accepts world with all optional fields', () => {
      const w = WorldRecordSchema.parse({
        worldId: 'w2',
        name: '光影同行',
        description: '一个关于成长的故事',
        constitution: '不允许降智推进',
        status: 'active',
        threadId: 'thread_abc',
        createdBy: { kind: 'user', id: 'you' },
        createdAt: NOW,
        updatedAt: NOW,
      });
      assert.equal(w.constitution, '不允许降智推进');
      assert.equal(w.threadId, 'thread_abc');
    });

    it('rejects world without name', () => {
      assert.throws(() =>
        WorldRecordSchema.parse({
          worldId: 'w3',
          status: 'draft',
          createdBy: actor,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    });
  });

  describe('CharacterRecord (5 slots)', () => {
    const char: CharacterRecord = {
      characterId: 'c1',
      worldId: 'w1',
      coreIdentity: { name: 'A.W.', description: '一个黑客' },
      innerDrive: { motivation: '寻找真相' },
      relationshipTension: { bonds: [] },
      voiceAndImage: {},
      growthState: {},
      createdAt: NOW,
      updatedAt: NOW,
    };

    it('accepts character with 5 slots', () => {
      const c = CharacterRecordSchema.parse(char);
      assert.equal(c.coreIdentity.name, 'A.W.');
      assert.equal(c.innerDrive.motivation, '寻找真相');
    });

    it('accepts character with bonds', () => {
      const c = CharacterRecordSchema.parse({
        ...char,
        relationshipTension: {
          bonds: [
            {
              targetCharacterId: 'c2',
              nature: 'rivalry',
              tension: '谁才是真正的守护者',
              intensity: 75,
            },
          ],
        },
      });
      assert.equal(c.relationshipTension.bonds[0].intensity, 75);
    });

    it('accepts character with mask overlay', () => {
      const c = CharacterRecordSchema.parse({
        ...char,
        maskOverlay: {
          overlayPersonality: '冷酷无情',
          sceneDisplayName: '暗影行者',
        },
      });
      assert.equal(c.maskOverlay?.sceneDisplayName, '暗影行者');
    });

    it('accepts character linked to a cat', () => {
      const c = CharacterRecordSchema.parse({ ...char, baseCatId: 'opus' });
      assert.equal(c.baseCatId, 'opus');
    });

    it('rejects character without coreIdentity', () => {
      const { coreIdentity: _, ...rest } = char;
      assert.throws(() => CharacterRecordSchema.parse(rest));
    });
  });

  describe('SceneRecord', () => {
    it('accepts valid scene', () => {
      const s = SceneRecordSchema.parse({
        sceneId: 's1',
        worldId: 'w1',
        name: '深夜咖啡馆',
        mode: 'perform',
        status: 'active',
        activeCharacterIds: ['c1', 'c2'],
        setting: '灯光昏暗，雨声淅沥',
        createdAt: NOW,
        updatedAt: NOW,
      });
      assert.equal(s.activeCharacterIds.length, 2);
      assert.equal(s.setting, '灯光昏暗，雨声淅沥');
    });
  });

  describe('WorldActionEnvelope', () => {
    const base = {
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'perform' as const,
      idempotencyKey: 'idem-1',
    };

    it('accepts perform_dialogue action', () => {
      const env: WorldActionEnvelope = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [{ type: 'perform_dialogue', characterId: 'c1', content: '你好' }],
      });
      assert.equal(env.actions[0].type, 'perform_dialogue');
    });

    it('accepts narrate action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [{ type: 'narrate', content: '夜幕降临' }],
      });
      assert.equal(env.actions[0].type, 'narrate');
    });

    it('accepts edit_character_definition action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        mode: 'build',
        actions: [
          {
            type: 'edit_character_definition',
            characterId: 'c1',
            slot: 'coreIdentity',
            patch: [{ op: 'replace', path: '/name', value: 'New Name' }],
          },
        ],
      });
      assert.equal(env.actions[0].type, 'edit_character_definition');
    });

    it('accepts update_character_state action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [
          {
            type: 'update_character_state',
            characterId: 'c1',
            slot: 'growthState',
            patch: [{ op: 'add', path: '/milestones/-', value: '第一次战斗' }],
          },
        ],
      });
      assert.equal(env.actions[0].type, 'update_character_state');
    });

    it('accepts propose_canon action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [
          {
            type: 'propose_canon',
            sourceEventId: 'evt-1',
            summary: 'A.W. 是黑客',
            category: 'character_trait',
          },
        ],
      });
      assert.equal(env.actions[0].type, 'propose_canon');
    });

    it('accepts decide_canon action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [
          {
            type: 'decide_canon',
            recordId: 'canon-1',
            decision: 'accepted',
            reason: '符合世界观',
          },
        ],
      });
      assert.equal(env.actions[0].type, 'decide_canon');
    });

    it('accepts transition_scene action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [
          {
            type: 'transition_scene',
            newSceneName: '雨中追逐',
            newSceneDescription: '暴雨中的街道',
          },
        ],
      });
      assert.equal(env.actions[0].type, 'transition_scene');
    });

    it('accepts care_check_in action', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [
          {
            type: 'care_check_in',
            suggestion: '喝杯水休息一下',
            realityBridge: '你今天的步数够了吗？',
          },
        ],
      });
      assert.equal(env.actions[0].type, 'care_check_in');
    });

    it('accepts batch actions', () => {
      const env = WorldActionEnvelopeSchema.parse({
        ...base,
        actions: [
          { type: 'perform_dialogue', characterId: 'c1', content: '你好' },
          {
            type: 'update_character_state',
            characterId: 'c1',
            slot: 'relationshipTension',
            patch: [{ op: 'add', path: '/bonds/-', value: { targetCharacterId: 'c2', nature: 'ally' } }],
          },
        ],
      });
      assert.equal(env.actions.length, 2);
    });

    it('rejects unknown action type', () => {
      assert.throws(() =>
        WorldActionEnvelopeSchema.parse({
          ...base,
          actions: [{ type: 'unknown_action' }],
        }),
      );
    });
  });

  describe('CanonPromotionRecord', () => {
    it('accepts proposed record', () => {
      const r: CanonPromotionRecord = CanonPromotionRecordSchema.parse({
        recordId: 'canon-1',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-1',
        status: 'proposed',
        summary: 'A.W. 的真名是...',
        proposedBy: actor,
        createdAt: NOW,
      });
      assert.equal(r.status, 'proposed');
      assert.equal(r.decidedBy, undefined);
    });

    it('accepts accepted record with decidedBy', () => {
      const r = CanonPromotionRecordSchema.parse({
        recordId: 'canon-2',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-2',
        status: 'accepted',
        summary: '世界规则：不允许时间穿越',
        category: 'world_rule',
        proposedBy: actor,
        decidedBy: { kind: 'user', id: 'you' },
        reason: '符合世界观基调',
        createdAt: NOW,
        decidedAt: NOW,
      });
      assert.equal(r.decidedBy?.kind, 'user');
    });

    it('rejects invalid status', () => {
      assert.throws(() =>
        CanonPromotionRecordSchema.parse({
          recordId: 'canon-3',
          worldId: 'w1',
          sceneId: 's1',
          sourceEventId: 'evt-3',
          status: 'pending',
          summary: 'test',
          proposedBy: actor,
          createdAt: NOW,
        }),
      );
    });
  });

  describe('WorldEventEntry', () => {
    it('accepts dialogue event', () => {
      const e = WorldEventEntrySchema.parse({
        eventId: 'evt-1',
        worldId: 'w1',
        sceneId: 's1',
        type: 'dialogue',
        actor,
        characterId: 'c1',
        payload: { content: '你好世界' },
        createdAt: NOW,
      });
      assert.equal(e.type, 'dialogue');
      assert.equal(e.characterId, 'c1');
    });

    it('accepts canon_accepted event with canonRecordId', () => {
      const e = WorldEventEntrySchema.parse({
        eventId: 'evt-2',
        worldId: 'w1',
        sceneId: 's1',
        type: 'canon_accepted',
        actor: { kind: 'system', id: 'coordinator' },
        payload: {},
        canonRecordId: 'canon-1',
        createdAt: NOW,
      });
      assert.equal(e.canonRecordId, 'canon-1');
    });

    it('rejects invalid event type', () => {
      assert.throws(() =>
        WorldEventEntrySchema.parse({
          eventId: 'evt-3',
          worldId: 'w1',
          sceneId: 's1',
          type: 'invalid_type',
          actor,
          payload: {},
          createdAt: NOW,
        }),
      );
    });
  });

  describe('WorldContextEnvelope', () => {
    it('accepts full envelope', () => {
      const env = WorldContextEnvelopeSchema.parse({
        world: {
          worldId: 'w1',
          name: '逐峰宇宙',
          status: 'active',
          createdBy: actor,
          createdAt: NOW,
          updatedAt: NOW,
        },
        scene: {
          sceneId: 's1',
          worldId: 'w1',
          name: '咖啡馆',
          mode: 'perform',
          status: 'active',
          activeCharacterIds: ['c1'],
          createdAt: NOW,
          updatedAt: NOW,
        },
        characters: [
          {
            characterId: 'c1',
            worldId: 'w1',
            coreIdentity: { name: 'A.W.', description: '黑客' },
            innerDrive: { motivation: '真相' },
            relationshipTension: { bonds: [] },
            voiceAndImage: {},
            growthState: {},
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        recentEvents: [],
        relationshipSnapshot: [],
        canonSummary: [{ recordId: 'c1', summary: '世界规则已建立', acceptedAt: NOW }],
        recall: { canonMatches: [], eventMatches: [] },
      });
      assert.equal(env.world.name, '逐峰宇宙');
      assert.equal(env.canonSummary.length, 1);
    });
  });
});
