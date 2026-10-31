import assert from 'node:assert/strict';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import { SessionMutex } from '../../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { EntityRegistryStore, entitySourceRevision } from '../../src/domains/memory/EntityRegistry.js';
import { EntityMemoryLifecycleService } from '../../src/domains/memory/entity/EntityMemoryLifecycleService.js';
import { EntityMemoryLifecycleStore } from '../../src/domains/memory/entity/EntityMemoryLifecycleStore.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../src/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import type { OwnerMemoryActionReceiptRecord } from '../../src/domains/memory/owner/OwnerMemoryActionReceiptStore.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

const requestId = 'entity-forget:218f2d5e-9f45-7d8c-a829-88f6440a4f15';

it('does not recover a never-owned Entity from absence alone', async () => {
  class InterruptedReceiptStore extends InMemoryOwnerMemoryActionReceiptStore {
    private interrupted = false;
    override async begin(record: OwnerMemoryActionReceiptRecord) {
      const saved = await super.begin(record);
      if (!this.interrupted) {
        this.interrupted = true;
        throw new Error('lost pending acknowledgement before Entity mutation');
      }
      return saved;
    }
  }
  let mutations = 0;
  const service = new EntityMemoryLifecycleService({
    store: {
      get: () => null,
      correct: () => {
        mutations++;
        return { outcome: 'not_available' };
      },
      retire: () => {
        mutations++;
        return { outcome: 'not_available' };
      },
      hardForget: () => {
        mutations++;
        return { outcome: 'not_available' };
      },
      getOwnerActionEvidence: () => null,
    },
    coordinator: new OwnerMemoryActionCoordinator({ store: new InterruptedReceiptStore(), lock: new SessionMutex() }),
    sourceAvailable: async () => false,
  });
  const command = {
    action: 'hard_forget' as const,
    requestId,
    expectedRevision: `sha256:${'a'.repeat(64)}`,
    confirmed: true as const,
  };
  await assert.rejects(service.executeOwnerAction('owner', 'never-owned', command), /lost pending acknowledgement/);
  assert.deepEqual(await service.executeOwnerAction('owner', 'never-owned', command), { error: 'not_available' });
  assert.equal(mutations, 0);
});

it('recovers Entity hard-forget from exact atomic action evidence', async () => {
  class LostCompletionStore extends InMemoryOwnerMemoryActionReceiptStore {
    private interrupted = false;
    override async complete(...args: Parameters<InMemoryOwnerMemoryActionReceiptStore['complete']>) {
      if (!this.interrupted) {
        this.interrupted = true;
        throw new Error('lost Entity completion before receipt commit');
      }
      return super.complete(...args);
    }
  }
  const db = new Database(':memory:');
  applyMigrations(db);
  const registry = new EntityRegistryStore(db);
  registry.upsert(
    [
      {
        entityId: 'concept:recovery',
        type: 'concept',
        canonicalName: 'Recovery',
        aliases: ['recovery'],
        provenance: [{ source: 'test' }],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        status: 'active',
        updatedAt: '2026-10-06T00:00:00.000Z',
      },
    ],
    { source: 'system' },
  );
  const entity = registry.get('concept:recovery');
  assert.ok(entity);
  const store = new EntityMemoryLifecycleStore(db);
  const service = new EntityMemoryLifecycleService({
    store,
    coordinator: new OwnerMemoryActionCoordinator({ store: new LostCompletionStore(), lock: new SessionMutex() }),
    sourceAvailable: async () => true,
  });
  const command = {
    action: 'hard_forget' as const,
    requestId,
    expectedRevision: entitySourceRevision(entity),
    confirmed: true as const,
  };
  await assert.rejects(service.executeOwnerAction('owner', entity.entityId, command), /lost Entity completion/);
  const recovered = await service.executeOwnerAction('owner', entity.entityId, command);
  assert.equal(recovered.outcome, 'replayed');
  assert.equal(recovered.action, 'hard_forget');
  db.close();
});
