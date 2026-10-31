import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import { SessionMutex } from '../../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { FileProfileRepository } from '../../src/domains/cats/services/profile/ProfileRepository.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../src/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import type { OwnerMemoryActionReceiptRecord } from '../../src/domains/memory/owner/OwnerMemoryActionReceiptStore.js';
import { ProfileMemoryLifecycleService } from '../../src/domains/memory/profile/ProfileMemoryLifecycleService.js';
import { ProfileMemoryLifecycleStore } from '../../src/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

const revision = `sha256:${'a'.repeat(64)}`;
const command = {
  action: 'hard_forget' as const,
  requestId: 'profile-forget:218f2d5e-9f45-7d8c-a829-88f6440a4f15',
  expectedRevision: revision,
  confirmed: true as const,
};

it('does not recover Profile hard-forget from canonical absence alone', async () => {
  class InterruptedReceiptStore extends InMemoryOwnerMemoryActionReceiptStore {
    private interrupted = false;
    override async begin(record: OwnerMemoryActionReceiptRecord) {
      const saved = await super.begin(record);
      if (!this.interrupted) {
        this.interrupted = true;
        throw new Error('lost pending acknowledgement before Profile mutation');
      }
      return saved;
    }
  }
  let mutations = 0;
  const service = new ProfileMemoryLifecycleService({
    store: {
      get: () => null,
      replaceContent: () => {
        mutations++;
        return { outcome: 'not_available' } as const;
      },
      hardForget: () => {
        mutations++;
        return { outcome: 'not_available' } as const;
      },
      getOwnerActionEvidence: () => null,
      finishHardForgetCleanup: () => undefined,
    },
    coordinator: new OwnerMemoryActionCoordinator({ store: new InterruptedReceiptStore(), lock: new SessionMutex() }),
    invalidateDerived: async () => undefined,
  });
  await assert.rejects(service.executeOwnerAction('owner', 'corpus', command), /lost pending acknowledgement/);
  assert.deepEqual(await service.executeOwnerAction('owner', 'corpus', command), { error: 'not_available' });
  assert.equal(mutations, 0);
});

it('recovers only from exact per-request Profile mutation evidence', async () => {
  class LostCompletionStore extends InMemoryOwnerMemoryActionReceiptStore {
    private interrupted = false;
    override async complete(...args: Parameters<InMemoryOwnerMemoryActionReceiptStore['complete']>) {
      if (!this.interrupted) {
        this.interrupted = true;
        throw new Error('lost Profile completion before receipt commit');
      }
      return super.complete(...args);
    }
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'f321-profile-recovery-'));
  const db = new Database(':memory:');
  applyMigrations(db);
  const repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'maine-coon' });
  mkdirSync(dirname(repository.corpusPath('owner')), { recursive: true });
  writeFileSync(repository.corpusPath('owner'), 'profile', 'utf8');
  const store = new ProfileMemoryLifecycleStore({ db, repository });
  const current = store.get('owner', 'corpus');
  assert.ok(current);
  let invalidations = 0;
  const service = new ProfileMemoryLifecycleService({
    store,
    coordinator: new OwnerMemoryActionCoordinator({ store: new LostCompletionStore(), lock: new SessionMutex() }),
    invalidateDerived: async () => {
      invalidations++;
    },
  });
  const exactCommand = { ...command, expectedRevision: current.revision };
  try {
    await assert.rejects(service.executeOwnerAction('owner', 'corpus', exactCommand), /lost Profile completion/);
    assert.equal(repository.readCorpus('owner'), null);
    const recovered = await service.executeOwnerAction('owner', 'corpus', exactCommand);
    assert.equal(recovered.outcome, 'replayed');
    assert.equal(recovered.action, 'hard_forget');
    assert.equal(invalidations, 2);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
