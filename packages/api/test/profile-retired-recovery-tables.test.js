import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import { ProfileMemoryLifecycleStore } from '../dist/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';

test('retired recovery tables do not block owner correction or forgetting', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'profile-retired-recovery-'));
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  applyMigrations(db);
  const repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'maine-coon' });
  mkdirSync(dirname(repository.corpusPath('owner')), { recursive: true });
  writeFileSync(repository.corpusPath('owner'), 'original profile', 'utf8');
  const store = new ProfileMemoryLifecycleStore({ db, repository });
  // A database upgraded by #6949 may retain these unused rows after code rollback.
  db.exec(`CREATE TABLE IF NOT EXISTS profile_target_state (
    owner_user_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    target_generation INTEGER NOT NULL DEFAULT 0,
    projected_generation INTEGER NOT NULL DEFAULT 0,
    last_committed_revision TEXT, active_effect_ref TEXT,
    PRIMARY KEY(owner_user_id, memory_id));
    INSERT INTO profile_target_state(owner_user_id,memory_id,active_effect_ref)
    VALUES('owner','corpus','retired-effect');`);
  const correction = store.replaceContent({
    ownerUserId: 'owner',
    memoryId: 'corpus',
    command: {
      action: 'replace_content',
      requestId: 'correction',
      expectedRevision: store.get('owner', 'corpus').revision,
      content: 'corrected profile',
    },
  });
  assert.equal(correction.outcome, 'applied');
  assert.equal(repository.readCorpus('owner').content, 'corrected profile');
  const forgotten = store.hardForget({
    ownerUserId: 'owner',
    memoryId: 'corpus',
    command: {
      action: 'hard_forget',
      requestId: 'forget',
      expectedRevision: store.get('owner', 'corpus').revision,
      confirmed: true,
    },
  });
  assert.equal(forgotten.outcome, 'forgotten');
  assert.equal(repository.readCorpus('owner'), null);
});
