import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import Database from 'better-sqlite3';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import { ProfileMemoryLifecycleStore } from '../src/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { readRecallSourceViews } from '../src/routes/recall-candidate-view.js';
import { recallFixture } from './memory-recall-fixture.js';

let db: Database.Database;
let dataDir: string;
let profiles: ProfileMemoryLifecycleStore;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE evidence_docs (anchor TEXT, title TEXT, kind TEXT, collection_id TEXT, world_id TEXT);
    CREATE TABLE memory_cue_events (owner_user_id TEXT, thread_id TEXT, invocation_id TEXT, cue_id TEXT,
      resolver_family TEXT, source_anchor TEXT, source_revision TEXT, consumer_cat_id TEXT, occurred_at INTEGER);`);
  dataDir = mkdtempSync(join(tmpdir(), 'f321-owner-profile-'));
  const repository = new FileProfileRepository({ dataDir });
  for (const [path, content] of [
    [repository.capsulePath('owner'), 'OWNER_CAPSULE_BODY'],
    [repository.corpusPath('owner'), 'OWNER_CORPUS_BODY'],
    [repository.primerPathForRelationship('owner', 'ragdoll'), 'OWNER_RELATIONSHIP_BODY'],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  profiles = new ProfileMemoryLifecycleStore({ db, repository });
});

for (const [memoryId, anchor] of [
  ['capsule', 'profile:opening-capsule'],
  ['primer:ragdoll', 'profile:opening-primer:ragdoll:sonnet'],
]) {
  it(`opens ${anchor} through the owner reader and keeps changed historical content unavailable`, async () => {
    const entry = profiles.get('owner', memoryId);
    assert.ok(entry);
    seed(anchor, entry.revision);
    const read = () =>
      readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], {
        profileMemoryStore: profiles,
        cueSourceReader: {
          async read() {
            assert.fail('opening owner navigation must not borrow a model grant');
          },
        },
      });
    const first = (await read())[0];
    assert.ok(first?.href?.includes(`memoryId=${encodeURIComponent(memoryId)}`), JSON.stringify(first));
    assert.equal(first.profileMemoryId, memoryId);
    assert.match(first.title ?? '', /^开场递送/);
    assert.equal(first.sourceRevision, entry.revision);
    writeFileSync(entry.path, 'NEW_OWNER_PROFILE_BODY');
    const changed = (await read())[0];
    assert.equal(changed?.href, null);
    assert.equal(changed?.sourceUnavailableReason, 'source_corrected');
    assert.equal(changed?.sourceRevision, entry.revision);
    assert.doesNotMatch(JSON.stringify(changed), /OWNER_.*BODY/);
  });
}
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
function seed(anchor: string, revision: string, consumer = 'sonnet') {
  db.prepare('INSERT INTO memory_cue_events VALUES (?,?,?,?,?,?,?,?,?)').run(
    'owner',
    'thread',
    'inv',
    'cue',
    'profile',
    anchor,
    revision,
    consumer,
    1,
  );
}

it('opens the exact owner primer without borrowing an expired model opportunity', async () => {
  const entry = profiles.get('owner', 'primer:ragdoll');
  assert.ok(entry);
  seed('profile:primer:ragdoll:sonnet', entry.revision);
  let modelDrills = 0;
  const views = await readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], {
    profileMemoryStore: profiles,
    cueSourceReader: {
      async read() {
        modelDrills++;
        return { status: 'not_available', invalidationReason: 'scope_revoked' };
      },
    },
  });
  assert.equal(modelDrills, 0, 'owner display must use its existing owner reader, not a model drill grant');
  assert.equal(views[0]?.title, entry.title);
  assert.equal(
    views[0]?.href,
    `/memory?family=profile&memoryId=primer%3Aragdoll&revision=${encodeURIComponent(entry.revision)}&from=thread`,
  );
  assert.equal(views[0]?.sourceRevision, entry.revision);
  assert.ok(!JSON.stringify(views).includes('OWNER_RELATIONSHIP_BODY'));
});

it('keeps corpus source navigation version-bound and preserves a corrected historical delivery', async () => {
  const entry = profiles.get('owner', 'corpus');
  assert.ok(entry);
  seed('profile:cat-cafe-profile://corpus/current', entry.revision);
  const read = () => readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], { profileMemoryStore: profiles });
  const first = (await read())[0];
  assert.equal(first?.title, entry.title);
  assert.ok(first?.href?.includes('memoryId=corpus'));
  writeFileSync(entry.path, 'CORRECTED_OWNER_CORPUS_BODY');
  const corrected = (await read())[0];
  assert.equal(corrected?.href, null);
  assert.equal(corrected?.sourceRevision, entry.revision, 'keep delivered revision; do not silently replace it');
  assert.equal(corrected?.sourceUnavailableReason, 'source_corrected');
  assert.ok(!JSON.stringify(corrected).includes('CORRECTED_OWNER_CORPUS_BODY'));
});

it('does not expose a different consumer binding or invent a forgotten profile target', async () => {
  const entry = profiles.get('owner', 'primer:ragdoll');
  assert.ok(entry);
  seed('profile:primer:ragdoll:other-cat', entry.revision);
  const wrongBinding = await readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], {
    profileMemoryStore: profiles,
  });
  assert.equal(wrongBinding[0]?.href, null);
  assert.equal(wrongBinding[0]?.title, undefined);
  assert.equal(wrongBinding[0]?.sourceUnavailableReason, 'scope_revoked');
  db.prepare('UPDATE memory_cue_events SET source_anchor = ?').run('profile:primer:missing:sonnet');
  const forgotten = await readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], { profileMemoryStore: profiles });
  assert.equal(forgotten[0]?.href, null);
  assert.equal(forgotten[0]?.sourceUnavailableReason, 'source_forgotten');
  assert.ok(!JSON.stringify(forgotten).includes('OWNER_'));
});

it('isolates an unavailable owner reader without borrowing a model grant or dropping other sources', async () => {
  seed('profile:cat-cafe-profile://corpus/current', 'r1');
  db.prepare('INSERT INTO evidence_docs VALUES (?,?,?,?,?)').run('visible', '可读资料', 'feature', null, null);
  const views = await readRecallSourceViews(
    db,
    'owner',
    'thread',
    [{ candidates_json: '[{"anchor":"visible"}]' }],
    ['inv'],
    {
      profileMemoryStore: {
        get() {
          throw new Error('owner store temporarily unavailable');
        },
      },
      cueSourceReader: {
        async read() {
          assert.fail('must not fall back to a model grant');
        },
      },
    },
  );
  assert.equal(views[0]?.title, '可读资料');
  assert.equal(views[1]?.href, null);
  assert.equal(views[1]?.titleStatus, 'unavailable');
  assert.equal(views[1]?.sourceUnavailableReason, undefined, 'an IO failure is not evidence of forgetting');
});

it('does not cache a valid consumer admission for a different consumer on the same source', async () => {
  const entry = profiles.get('owner', 'primer:ragdoll');
  assert.ok(entry);
  seed('profile:primer:ragdoll:sonnet', entry.revision);
  db.prepare('INSERT INTO memory_cue_events VALUES (?,?,?,?,?,?,?,?,?)').run(
    'owner',
    'thread',
    'inv',
    'other-cue',
    'profile',
    'profile:primer:ragdoll:sonnet',
    entry.revision,
    'other-cat',
    0,
  );
  const views = await readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], { profileMemoryStore: profiles });
  assert.ok(views.find((view) => view.cueId === 'cue')?.href);
  assert.equal(views.find((view) => view.cueId === 'other-cue')?.href, null);
  assert.equal(views.find((view) => view.cueId === 'other-cue')?.sourceUnavailableReason, 'scope_revoked');
});

it('projects the owner link and later invalidation through the actual memory recall route', async () => {
  const entry = profiles.get('owner', 'primer:ragdoll');
  assert.ok(entry);
  const f = await recallFixture((readers) => {
    readers.profileMemoryStore = profiles;
  });
  try {
    f.invocation('profile-inv');
    f.episodes.append({
      eventId: 'profile-event',
      idempotencyKey: 'profile-present',
      cueId: 'profile-cue',
      opportunityId: 'original-opportunity',
      scope: { ownerUserId: 'owner', threadId: 'own', invocationId: 'profile-inv' },
      consumerCatId: 'sonnet',
      resolverFamily: 'profile',
      sourceAnchor: 'profile:primer:ragdoll:sonnet',
      sourceRevision: entry.revision,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: 1,
      resolverVersion: 1,
      occurredAt: f.now - 100,
    });
    const response = await f.get('?source=push');
    assert.equal(response.statusCode, 200);
    const initial = response.json().records[0].event;
    assert.equal(initial.sourceRevision, entry.revision);
    assert.ok(initial.results[0].href.includes('memoryId=primer%3Aragdoll'));
    assert.equal(initial.results[0].title, entry.title);
    writeFileSync(entry.path, 'NEW_OWNER_BODY');
    const changed = (await f.get('?source=push')).json().records[0].event;
    assert.equal(changed.sourceRevision, entry.revision);
    assert.equal(changed.results[0].href, null);
    assert.equal(changed.results[0].sourceUnavailableReason, 'source_corrected');
    assert.ok(!JSON.stringify(changed).includes('NEW_OWNER_BODY'));
  } finally {
    await f.close();
  }
});
