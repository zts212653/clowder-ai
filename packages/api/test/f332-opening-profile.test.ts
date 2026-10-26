import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import { profileRevisionOf } from '@cat-cafe/shared/profile-revision';
import Database from 'better-sqlite3';
import { SessionMutex } from '../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { L0ProfileCache } from '../src/domains/cats/services/agents/providers/l0-profile-cache.js';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import { MemoryCueEpisodeStore } from '../src/domains/memory/cue/MemoryCueEpisodeStore.js';
import { projectInvocationCues } from '../src/domains/memory/cue/project-invocation-cues.js';
import type { IEvidenceStore } from '../src/domains/memory/interfaces.js';
import { LibraryCatalog } from '../src/domains/memory/LibraryCatalog.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../src/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { refreshCanonicalProfileIndex } from '../src/domains/memory/private-collection-bindings.js';
import { recordNativeProfileOpening } from '../src/domains/memory/profile/native-profile-opening.js';
import { ProfileMemoryLifecycleService } from '../src/domains/memory/profile/ProfileMemoryLifecycleService.js';
import { ProfileMemoryLifecycleStore } from '../src/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import type { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations } from '../src/domains/memory/schema.js';

const owner = 'opening-profile-owner';
let dataDir: string;
let db: Database.Database;
let repository: FileProfileRepository;
let store: ProfileMemoryLifecycleStore;
let lifecycle: ProfileMemoryLifecycleService;
let invalidations: string[];
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'f332-opening-profile-'));
  repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'astra' });
  mkdirSync(repository.profileDir(owner), { recursive: true });
  writeFileSync(join(repository.profileDir(owner), 'operator-capsule.md'), '先讲结果。');
  db = new Database(':memory:');
  applyMigrations(db);
  store = new ProfileMemoryLifecycleStore({ db, repository });
  invalidations = [];
  lifecycle = new ProfileMemoryLifecycleService({
    store,
    coordinator: new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    }),
    targetLock: new SessionMutex(),
    invalidateDerived: async ({ memoryId }) => {
      invalidations.push(memoryId);
    },
  });
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('native capsule observation persists in the original owner ledger with honest use status and no body', () => {
  const episodes = new MemoryCueEpisodeStore(db);
  const delivery = {
    scope: { ownerUserId: owner, threadId: 'thread', invocationId: 'invocation' },
    consumerCatId: 'astra',
    sourceRevision: repository.readCapsule(owner)!.revision,
    requestGenerationId: 'generation',
    observedAt: 1000,
  };
  recordNativeProfileOpening(episodes, delivery);
  recordNativeProfileOpening(episodes, delivery);
  const events = episodes.listByInvocation(owner, 'thread', 'invocation');
  assert.equal(events.length, 1);
  assert.equal(episodes.listByInvocation('other-owner', 'thread', 'invocation').length, 0);
  const [view] = projectInvocationCues(events);
  assert.equal(view?.status, 'presented_unreported');
  assert.equal(view?.pushSurface, 'profile_opening');
  assert.doesNotMatch(JSON.stringify(events), /先讲结果/);
});

test('the opening capsule is visible through the original profile owner and correction changes the next rendering', async () => {
  const entry = store.list(owner).find((item) => item.id === 'capsule');
  assert.ok(entry, 'opening capsule must be manageable in the existing profile lane');
  assert.equal(store.get('other-owner', 'capsule'), null);
  const cache = new L0ProfileCache();
  const cacheKey = cache.key(owner, 'astra');
  const signature = cache.refreshProfileSignature(cacheKey, repository.profileDir(owner));
  assert.ok(signature);
  cache.set(cacheKey, 'compiled legacy capsule', signature);
  const command = {
    action: 'replace_content' as const,
    requestId: 'opening-correction-1',
    expectedRevision: entry.revision,
    content: '先讲结果，再给有用的依据。',
  };
  const result = await lifecycle.executeOwnerAction(owner, 'capsule', command);
  assert.ok(!('error' in result), JSON.stringify(result));
  assert.match(renderUserCapsuleSection(repository.readCapsule(owner)!.content), /再给有用的依据/);
  assert.notEqual(store.get(owner, 'capsule')?.revision, entry.revision);
  const stale = await lifecycle.executeOwnerAction(owner, 'capsule', {
    ...command,
    requestId: 'stale-edit',
    content: '旧内容',
  });
  assert.deepEqual(stale, { error: 'stale_revision' });
  const replay = await lifecycle.executeOwnerAction(owner, 'capsule', command);
  assert.ok(!('error' in replay) && replay.outcome === 'replayed');
  assert.ok(invalidations.includes('capsule'));
  assert.equal(repository.capsulePath(owner), join(repository.profileDir(owner), 'capsule.md'));
  assert.equal(readFileSync(repository.capsulePath(owner), 'utf8'), command.content);
  assert.equal(readFileSync(join(repository.profileDir(owner), 'operator-capsule.md'), 'utf8'), '先讲结果。');
  assert.notEqual(cache.refreshProfileSignature(cacheKey, repository.profileDir(owner)), signature);
  assert.equal(cache.get(cacheKey), undefined, 'switching to the canonical file invalidates compiled opening content');
});

test('an empty owner can create a capsule without inheriting another owner, and concurrent first edits are fenced', async () => {
  const newOwner = 'new-owner';
  const command = {
    action: 'replace_content' as const,
    requestId: 'new-owner-capsule',
    expectedRevision: profileRevisionOf(''),
    content: '示例用户喜欢先看图。',
  };
  assert.equal(repository.readCapsule(newOwner), null);
  const result = await lifecycle.executeOwnerAction(newOwner, 'capsule', command);
  assert.ok(!('error' in result), JSON.stringify(result));
  assert.equal(repository.readCapsule(newOwner)?.content, command.content);
  assert.equal(repository.readCapsule(owner)?.content, '先讲结果。');
  assert.deepEqual(
    await lifecycle.executeOwnerAction(newOwner, 'capsule', {
      ...command,
      requestId: 'other-first-edit',
      content: '迟到的首次编辑',
    }),
    { error: 'stale_revision' },
  );
  assert.deepEqual(await lifecycle.executeOwnerAction('third-owner', 'corpus', command), { error: 'not_available' });
});

test('canonical capsule content and tombstones shadow a legacy file instead of reviving stale text', () => {
  writeFileSync(join(repository.profileDir(owner), 'capsule.md'), '新版胶囊');
  assert.equal(repository.readCapsule(owner)?.content, '新版胶囊');
  writeFileSync(
    join(repository.profileDir(owner), 'capsule.md'),
    JSON.stringify({ catCafeProfileTombstone: 1, ownerUserId: owner }),
  );
  assert.equal(repository.readCapsule(owner), null);
});

test('the private search index uses the same effective capsule as opening reads, including crash tombstones', async () => {
  writeFileSync(join(repository.profileDir(owner), 'operator-capsule.md'), 'LEGACYHUMANMARKER');
  const catalog = new LibraryCatalog();
  const stores = new Map<string, IEvidenceStore>();
  const refresh = () => refreshCanonicalProfileIndex(stores, catalog, { dataDir, userId: owner });
  let index: SqliteEvidenceStore | undefined;
  try {
    assert.equal((await refresh()).status, 'registered');
    index = stores.get('domain:user-profile') as SqliteEvidenceStore;
    assert.equal((await index.search('LEGACYHUMANMARKER')).length, 1);
    const result = await lifecycle.executeOwnerAction(owner, 'capsule', {
      action: 'replace_content',
      requestId: 'indexed-capsule-edit',
      expectedRevision: repository.readCapsule(owner)!.revision,
      content: 'CURRENTHUMANMARKER',
    });
    assert.ok(!('error' in result));
    assert.equal((await refresh()).status, 'refreshed');
    assert.equal((await index.search('LEGACYHUMANMARKER')).length, 0, 'a shadowed file must not remain searchable');
    assert.equal((await index.search('CURRENTHUMANMARKER')).length, 1);
    writeFileSync(
      repository.capsulePath(owner),
      JSON.stringify({ catCafeProfileTombstone: 1, requestId: 'partial-forget' }),
    );
    assert.equal((await refresh()).status, 'refreshed');
    assert.equal((await index.search('LEGACYHUMANMARKER')).length, 0);
    assert.equal((await index.search('CURRENTHUMANMARKER')).length, 0);
    assert.equal((await index.search('catCafeProfileTombstone')).length, 0);
  } finally {
    index?.close();
  }
});

test('oversize correction cannot poison the next model startup', async () => {
  const revision = repository.readCapsule(owner)!.revision;
  const result = await lifecycle.executeOwnerAction(owner, 'capsule', {
    action: 'replace_content',
    requestId: 'opening-oversize',
    expectedRevision: revision,
    content: '猫'.repeat(301),
  });
  assert.deepEqual(result, { error: 'invalid_content' });
  assert.equal(repository.readCapsule(owner)?.revision, revision);
  assert.equal(readFileSync(join(repository.profileDir(owner), 'operator-capsule.md'), 'utf8'), '先讲结果。');
});

test('forget removes future capsule reads and a crash tombstone is never prompt content', async () => {
  const revision = repository.readCapsule(owner)!.revision;
  const result = await lifecycle.executeOwnerAction(owner, 'capsule', {
    action: 'hard_forget',
    requestId: 'opening-forget',
    expectedRevision: revision,
    confirmed: true,
  });
  assert.ok(!('error' in result), JSON.stringify(result));
  assert.equal(repository.readCapsule(owner), null);
  const marker = JSON.stringify({ catCafeProfileTombstone: 1, ownerUserId: owner, memoryId: 'capsule' });
  writeFileSync(join(repository.profileDir(owner), 'operator-capsule.md'), marker);
  assert.equal(repository.readCapsule(owner), null);
  assert.equal(renderUserCapsuleSection(marker), '');
});
