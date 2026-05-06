import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteWorldStore } from '../../dist/domains/world/SqliteWorldStore.js';
import { applyMigrations } from '../../dist/domains/world/schema.js';

const NOW = '2026-04-30T12:00:00Z';
const LATER = '2026-04-30T13:00:00Z';
const actor = { kind: 'cat', id: 'opus', displayName: '宪宪' };
const userActor = { kind: 'user', id: 'you' };

function makeWorld(overrides = {}) {
  return {
    worldId: 'w1',
    name: '逐峰宇宙',
    status: 'draft',
    createdBy: actor,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCharacter(overrides = {}) {
  return {
    characterId: 'c1',
    worldId: 'w1',
    coreIdentity: { name: 'A.W.', description: '一个黑客' },
    innerDrive: { motivation: '寻找真相' },
    relationshipTension: { bonds: [] },
    voiceAndImage: {},
    growthState: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeScene(overrides = {}) {
  return {
    sceneId: 's1',
    worldId: 'w1',
    name: '深夜咖啡馆',
    mode: 'perform',
    status: 'active',
    activeCharacterIds: ['c1'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('SqliteWorldStore', () => {
  /** @type {import('../../dist/domains/world/SqliteWorldStore.js').SqliteWorldStore} */
  let store;

  beforeEach(async () => {
    store = new SqliteWorldStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
  });

  describe('schema migrations', () => {
    it('creates all required tables', () => {
      const db = new Database(':memory:');
      applyMigrations(db);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.ok(tables.includes('worlds'), 'worlds table');
      assert.ok(tables.includes('world_characters'), 'world_characters table');
      assert.ok(tables.includes('world_scenes'), 'world_scenes table');
      assert.ok(tables.includes('canon_promotion_records'), 'canon_promotion_records table');
      assert.ok(tables.includes('world_event_log'), 'world_event_log table');
      assert.ok(tables.includes('schema_version'), 'schema_version table');
      db.close();
    });

    it('records schema version', () => {
      const db = new Database(':memory:');
      applyMigrations(db);
      const ver = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
      assert.equal(ver.v, 1);
      db.close();
    });

    it('migration is idempotent', () => {
      const db = new Database(':memory:');
      applyMigrations(db);
      applyMigrations(db);
      const ver = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
      assert.equal(ver.v, 1);
      db.close();
    });
  });

  describe('createWorld / getWorld', () => {
    it('creates and retrieves a world', async () => {
      const world = makeWorld();
      await store.createWorld(world);
      const got = await store.getWorld('w1');
      assert.equal(got.worldId, 'w1');
      assert.equal(got.name, '逐峰宇宙');
      assert.equal(got.status, 'draft');
      assert.deepEqual(got.createdBy, actor);
    });

    it('stores optional threadId', async () => {
      await store.createWorld(makeWorld({ threadId: 'thread_abc' }));
      const got = await store.getWorld('w1');
      assert.equal(got.threadId, 'thread_abc');
    });

    it('stores optional description and constitution', async () => {
      await store.createWorld(makeWorld({ description: '一个故事', constitution: '不允许降智' }));
      const got = await store.getWorld('w1');
      assert.equal(got.description, '一个故事');
      assert.equal(got.constitution, '不允许降智');
    });

    it('returns null for missing world', async () => {
      const got = await store.getWorld('nonexistent');
      assert.equal(got, null);
    });
  });

  describe('updateWorldStatus', () => {
    it('updates world status', async () => {
      await store.createWorld(makeWorld());
      await store.updateWorldStatus('w1', 'active', LATER);
      const got = await store.getWorld('w1');
      assert.equal(got.status, 'active');
      assert.equal(got.updatedAt, LATER);
    });
  });

  describe('upsertCharacter / getCharacter', () => {
    it('inserts and retrieves character with 5 slots', async () => {
      await store.createWorld(makeWorld());
      const char = makeCharacter();
      await store.upsertCharacter(char);
      const got = await store.getCharacter('c1');
      assert.equal(got.characterId, 'c1');
      assert.deepEqual(got.coreIdentity, { name: 'A.W.', description: '一个黑客' });
      assert.deepEqual(got.innerDrive, { motivation: '寻找真相' });
      assert.deepEqual(got.relationshipTension, { bonds: [] });
      assert.deepEqual(got.voiceAndImage, {});
      assert.deepEqual(got.growthState, {});
    });

    it('preserves maskOverlay and baseCatId', async () => {
      await store.createWorld(makeWorld());
      await store.upsertCharacter(
        makeCharacter({
          maskOverlay: { overlayPersonality: '冷酷', sceneDisplayName: '暗影' },
          baseCatId: 'opus',
        }),
      );
      const got = await store.getCharacter('c1');
      assert.deepEqual(got.maskOverlay, { overlayPersonality: '冷酷', sceneDisplayName: '暗影' });
      assert.equal(got.baseCatId, 'opus');
    });

    it('upsert updates existing character', async () => {
      await store.createWorld(makeWorld());
      await store.upsertCharacter(makeCharacter());
      await store.upsertCharacter(
        makeCharacter({
          coreIdentity: { name: 'A.W. v2', description: '进化的黑客' },
          updatedAt: LATER,
        }),
      );
      const got = await store.getCharacter('c1');
      assert.equal(got.coreIdentity.name, 'A.W. v2');
      assert.equal(got.updatedAt, LATER);
    });

    it('returns null for missing character', async () => {
      const got = await store.getCharacter('nonexistent');
      assert.equal(got, null);
    });

    it('getCharactersByWorld returns all characters in a world', async () => {
      await store.createWorld(makeWorld());
      await store.upsertCharacter(makeCharacter({ characterId: 'c1' }));
      await store.upsertCharacter(makeCharacter({ characterId: 'c2' }));
      const chars = await store.getCharactersByWorld('w1');
      assert.equal(chars.length, 2);
    });
  });

  describe('createScene / getScene', () => {
    it('creates and retrieves a scene', async () => {
      await store.createWorld(makeWorld());
      await store.createScene(makeScene());
      const got = await store.getScene('s1');
      assert.equal(got.sceneId, 's1');
      assert.equal(got.name, '深夜咖啡馆');
      assert.equal(got.mode, 'perform');
      assert.deepEqual(got.activeCharacterIds, ['c1']);
    });

    it('stores optional setting', async () => {
      await store.createWorld(makeWorld());
      await store.createScene(makeScene({ setting: '灯光昏暗' }));
      const got = await store.getScene('s1');
      assert.equal(got.setting, '灯光昏暗');
    });

    it('returns null for missing scene', async () => {
      const got = await store.getScene('nonexistent');
      assert.equal(got, null);
    });

    it('updateSceneStatus changes status', async () => {
      await store.createWorld(makeWorld());
      await store.createScene(makeScene());
      await store.updateSceneStatus('s1', 'completed', LATER);
      const got = await store.getScene('s1');
      assert.equal(got.status, 'completed');
      assert.equal(got.updatedAt, LATER);
    });
  });

  describe('appendEvent / getRecentEvents', () => {
    it('appends and retrieves events', async () => {
      await store.createWorld(makeWorld());
      await store.createScene(makeScene());
      await store.appendEvent({
        eventId: 'evt-1',
        worldId: 'w1',
        sceneId: 's1',
        type: 'dialogue',
        actor,
        characterId: 'c1',
        payload: { content: '你好' },
        createdAt: NOW,
      });
      const events = await store.getRecentEvents('w1', 's1');
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'dialogue');
      assert.equal(events[0].characterId, 'c1');
      assert.deepEqual(events[0].payload, { content: '你好' });
    });

    it('returns events in chronological order (newest last)', async () => {
      await store.createWorld(makeWorld());
      await store.createScene(makeScene());
      await store.appendEvent({
        eventId: 'evt-1',
        worldId: 'w1',
        sceneId: 's1',
        type: 'dialogue',
        actor,
        payload: {},
        createdAt: '2026-04-30T12:00:00Z',
      });
      await store.appendEvent({
        eventId: 'evt-2',
        worldId: 'w1',
        sceneId: 's1',
        type: 'narration',
        actor,
        payload: {},
        createdAt: '2026-04-30T12:01:00Z',
      });
      const events = await store.getRecentEvents('w1', 's1');
      assert.equal(events[0].eventId, 'evt-1');
      assert.equal(events[1].eventId, 'evt-2');
    });

    it('respects limit parameter', async () => {
      await store.createWorld(makeWorld());
      await store.createScene(makeScene());
      for (let i = 0; i < 5; i++) {
        await store.appendEvent({
          eventId: `evt-${i}`,
          worldId: 'w1',
          sceneId: 's1',
          type: 'dialogue',
          actor,
          payload: {},
          createdAt: `2026-04-30T12:0${i}:00Z`,
        });
      }
      const events = await store.getRecentEvents('w1', 's1', 3);
      assert.equal(events.length, 3);
      // Should return the 3 most recent
      assert.equal(events[0].eventId, 'evt-2');
    });
  });

  describe('canon promotion records', () => {
    it('creates and retrieves a canon record', async () => {
      await store.createWorld(makeWorld());
      await store.createCanonRecord({
        recordId: 'canon-1',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-1',
        status: 'proposed',
        summary: 'A.W. 的真名',
        proposedBy: actor,
        createdAt: NOW,
      });
      const got = await store.getCanonRecord('canon-1');
      assert.equal(got.status, 'proposed');
      assert.equal(got.summary, 'A.W. 的真名');
      assert.deepEqual(got.proposedBy, actor);
      assert.equal(got.decidedBy, undefined);
    });

    it('updates canon decision to accepted', async () => {
      await store.createWorld(makeWorld());
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
      await store.updateCanonDecision('canon-1', {
        status: 'accepted',
        decidedBy: userActor,
        reason: '符合世界观',
        decidedAt: LATER,
      });
      const got = await store.getCanonRecord('canon-1');
      assert.equal(got.status, 'accepted');
      assert.deepEqual(got.decidedBy, userActor);
      assert.equal(got.reason, '符合世界观');
      assert.equal(got.decidedAt, LATER);
    });

    it('getCanonSummary returns only accepted records', async () => {
      await store.createWorld(makeWorld());
      await store.createCanonRecord({
        recordId: 'canon-1',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-1',
        status: 'proposed',
        summary: '规则一',
        proposedBy: actor,
        createdAt: NOW,
      });
      await store.createCanonRecord({
        recordId: 'canon-2',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-2',
        status: 'proposed',
        summary: '规则二',
        proposedBy: actor,
        createdAt: NOW,
      });
      await store.updateCanonDecision('canon-2', {
        status: 'accepted',
        decidedBy: userActor,
        decidedAt: LATER,
      });
      const summary = await store.getCanonSummary('w1');
      assert.equal(summary.length, 1);
      assert.equal(summary[0].recordId, 'canon-2');
      assert.equal(summary[0].summary, '规则二');
      assert.equal(summary[0].acceptedAt, LATER);
    });
  });

  describe('getContext', () => {
    it('returns full context for a world+scene', async () => {
      await store.createWorld(makeWorld());
      await store.upsertCharacter(makeCharacter());
      await store.createScene(makeScene());
      await store.appendEvent({
        eventId: 'evt-1',
        worldId: 'w1',
        sceneId: 's1',
        type: 'dialogue',
        actor,
        characterId: 'c1',
        payload: { content: '你好' },
        createdAt: NOW,
      });
      await store.createCanonRecord({
        recordId: 'canon-1',
        worldId: 'w1',
        sceneId: 's1',
        sourceEventId: 'evt-1',
        status: 'proposed',
        summary: '规则',
        proposedBy: actor,
        createdAt: NOW,
      });
      await store.updateCanonDecision('canon-1', {
        status: 'accepted',
        decidedBy: userActor,
        decidedAt: NOW,
      });

      const ctx = await store.getContext('w1', 's1');
      assert.ok(ctx, 'context should not be null');
      assert.equal(ctx.world.worldId, 'w1');
      assert.equal(ctx.scene.sceneId, 's1');
      assert.equal(ctx.characters.length, 1);
      assert.equal(ctx.recentEvents.length, 1);
      assert.equal(ctx.canonSummary.length, 1);
    });

    it('returns null if world does not exist', async () => {
      const ctx = await store.getContext('nonexistent', 's1');
      assert.equal(ctx, null);
    });

    it('returns null if scene does not exist', async () => {
      await store.createWorld(makeWorld());
      const ctx = await store.getContext('w1', 'nonexistent');
      assert.equal(ctx, null);
    });

    it('rejects scene that belongs to a different world (P1-C)', async () => {
      await store.createWorld(makeWorld({ worldId: 'w1' }));
      await store.createWorld(makeWorld({ worldId: 'w2', name: '另一个宇宙' }));
      await store.createScene(makeScene({ sceneId: 's2', worldId: 'w2', name: 'w2 scene' }));

      const ctx = await store.getContext('w1', 's2');
      assert.equal(ctx, null, 'should not return context when scene belongs to different world');
    });
  });
});
