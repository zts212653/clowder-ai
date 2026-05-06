import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { SqliteWorldStore } from '../../dist/domains/world/SqliteWorldStore.js';
import { WorldContextProvider } from '../../dist/domains/world/WorldContextProvider.js';
import { WorldDriverBridge } from '../../dist/domains/world/WorldDriverBridge.js';
import { WorldKnowledgeAdapter } from '../../dist/domains/world/WorldKnowledgeAdapter.js';
import { WorldRuntimeCoordinator } from '../../dist/domains/world/WorldRuntimeCoordinator.js';

const NOW = '2026-04-30T12:00:00Z';

describe('WorldDriverBridge', () => {
  let worldStore;
  let evidenceStore;
  let bridge;

  beforeEach(async () => {
    worldStore = new SqliteWorldStore(':memory:');
    await worldStore.initialize();
    evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize();

    const adapter = new WorldKnowledgeAdapter(evidenceStore);
    const contextProvider = new WorldContextProvider(worldStore, adapter);
    const coordinator = new WorldRuntimeCoordinator(worldStore);

    bridge = new WorldDriverBridge(
      {
        resolver: 'hybrid',
        actions: ['perform_dialogue', 'narrate', 'propose_canon'],
        roles: ['narrator', 'player'],
        canonRules: ['majority vote'],
      },
      coordinator,
      contextProvider,
    );

    await worldStore.createWorld({
      worldId: 'w1',
      name: '逐峰宇宙',
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
      activeCharacterIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(() => {
    worldStore.close();
    evidenceStore.close();
  });

  it('exposes allowed actions from pack config', () => {
    assert.deepEqual(bridge.allowedActions, ['perform_dialogue', 'narrate', 'propose_canon']);
    assert.equal(bridge.resolver, 'hybrid');
  });

  it('validates envelope against allowed actions', () => {
    const errors = bridge.validateEnvelope({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'perform_dialogue', characterId: 'ch1', content: 'hello' }],
      idempotencyKey: 'k1',
    });
    assert.equal(errors.length, 0, 'allowed action should pass');

    const errors2 = bridge.validateEnvelope({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'transition_scene', targetSceneId: 's2' }],
      idempotencyKey: 'k2',
    });
    assert.equal(errors2.length, 1, 'disallowed action should fail');
    assert.ok(errors2[0].includes('transition_scene'));
  });

  it('execute rejects disallowed actions without touching store', async () => {
    const result = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'transition_scene', targetSceneId: 's2' }],
      idempotencyKey: 'k3',
    });
    assert.equal(result.events.length, 0);
    assert.ok(result.errors?.length > 0);
  });

  it('execute delegates valid actions to coordinator', async () => {
    const result = await bridge.execute({
      worldId: 'w1',
      sceneId: 's1',
      actorCatId: 'opus',
      mode: 'build',
      actions: [{ type: 'narrate', content: '夜幕降临' }],
      idempotencyKey: 'k4',
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, 'narration');
    assert.equal(result.errors, undefined);
  });

  it('getContext returns envelope from context provider', async () => {
    const envelope = await bridge.getContext('w1', 's1');
    assert.ok(envelope);
    assert.equal(envelope.world.name, '逐峰宇宙');
  });
});
