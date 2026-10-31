import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { RECALL_RESOLVER_FAMILIES, type RecallResolverFamily } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import type { MemoryCueSourceReader } from '../src/domains/memory/cue/MemoryCueSourceReader.js';
import { CanonicalTasteMemoryCueSource } from '../src/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { readRecallSourceViews } from '../src/routes/recall-candidate-view.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE evidence_docs (anchor TEXT, title TEXT, kind TEXT, collection_id TEXT, world_id TEXT);
    CREATE TABLE memory_cue_events (owner_user_id TEXT, thread_id TEXT, invocation_id TEXT, cue_id TEXT,
    resolver_family TEXT, source_anchor TEXT, source_revision TEXT, consumer_cat_id TEXT, occurred_at INTEGER DEFAULT 0);`);
});
afterEach(() => db.close());
function seed(family: RecallResolverFamily, anchor: string, revision = 'r1', owner = 'owner', thread = 'thread') {
  db.prepare('INSERT INTO memory_cue_events VALUES (?,?,?,?,?,?,?,?,?)').run(
    owner,
    thread,
    'inv',
    `${family}-${revision}`,
    family,
    anchor,
    revision,
    'sonnet',
    0,
  );
}
const titles = {
  thread_overview: '线程概况',
  person_entity: '吴浪',
  operational_precedent: '一次核验的经验',
  taste: '提到 ELI5 时先讲直觉',
  profile: '主人关系画像',
  event: '刚才确认了设计方向',
  decision: '已接受的决策',
  project_knowledge: 'F321 记忆界面',
  cat_owned_seed: '猫的私有种子（正文仅该猫可读）',
};
const readViews = (sourceReader: MemoryCueSourceReader) =>
  readRecallSourceViews(db, 'owner', 'thread', [], ['inv'], {
    cueSourceReader: sourceReader,
    personMemoryStore: { getPerson: async (ownerUserId) => ({ ownerUserId, displayName: '吴浪', status: 'active' }) },
  });

it('opening history identifies the profile owner target without using an expired cat drill as a human read', async () => {
  seed('profile', 'profile:opening-capsule');
  seed('profile', 'profile:opening-primer:astra:sonnet', 'r2');
  const views = await readViews({
    read: async () => {
      throw new Error('must not impersonate a cat drill');
    },
  });
  assert.equal(views.find((item) => item.anchor === 'profile:opening-capsule')?.profileMemoryId, 'capsule');
  const primer = views.find((item) => item.anchor === 'profile:opening-primer:astra:sonnet');
  assert.equal(primer?.profileMemoryId, 'primer:astra');
  assert.equal(primer?.title, '开场递送 · 关系参考');
  assert.equal(primer?.href, null, 'no fabricated profile deep link before the real UI entry exists');
});

it('reads identical cue source metadata once per request and keeps revision keys separate', async () => {
  const insert = db.prepare('INSERT INTO memory_cue_events VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [cueId, revision] of [
    ['a', 'r1'],
    ['b', 'r1'],
    ['c', 'r2'],
  ]) {
    insert.run('owner', 'thread', 'inv', cueId, 'taste', 'same', revision, 'sonnet', 1);
  }
  const reads: string[] = [];
  const reader: MemoryCueSourceReader = {
    read: async (input) => {
      reads.push(input.expectedRevision);
      return { status: 'ok', payload: { vignette: { when: input.expectedRevision } } };
    },
  };
  const views = await readViews(reader);
  assert.equal(views.length, 3);
  assert.deepEqual(reads.sort(), ['r1', 'r2']);
  assert.equal(views.find((view) => view.cueId === 'a')?.title, 'r1');
  assert.equal(views.find((view) => view.cueId === 'b')?.title, 'r1');
  await readViews(reader);
  assert.equal(reads.length, 4, 'cache must not cross the request boundary');
});

it('keeps the latest 200 cue coordinates by activity time rather than identifier order', async () => {
  const insert = db.prepare('INSERT INTO memory_cue_events VALUES (?,?,?,?,?,?,?,?,?)');
  for (let index = 0; index <= 200; index++) {
    insert.run('owner', 'thread', 'inv', `cue-${index}`, 'taste', 'same', 'r1', 'sonnet', index);
  }
  const views = await readViews({
    read: async () => ({ status: 'ok', payload: { vignette: { when: titles.taste } } }),
  });
  assert.equal(views.length, 200);
  assert.equal(views[0]?.cueId, 'cue-200');
  assert.ok(!views.some((view) => view.cueId === 'cue-0'));
});

it('projects readable titles for all admitted families without exporting source bodies', async () => {
  for (const family of RECALL_RESOLVER_FAMILIES) {
    const anchor = family === 'person_entity' ? 'person-memory:person_one' : family;
    seed(family, anchor);
    if (['operational_precedent', 'decision', 'project_knowledge'].includes(family)) {
      db.prepare('INSERT INTO evidence_docs VALUES (?,?,?,?,?)').run(anchor, titles[family], 'feature', null, null);
    }
  }
  const reader: MemoryCueSourceReader = {
    async read(input) {
      assert.notEqual(input.family, 'owned_seed', 'the human display must not drill the cat-private seed');
      assert.deepEqual(input.scope, { ownerUserId: 'owner', threadId: 'thread', invocationId: 'inv' });
      assert.equal(input.expectedRevision, 'r1');
      assert.equal(input.consumerCatId, 'sonnet');
      const payload =
        input.family === 'taste'
          ? { vignette: { when: titles.taste, quotes: ['PRIVATE'], scene: 'PRIVATE' } }
          : input.family === 'profile'
            ? { profileUri: 'cat-cafe-profile://relationship/current', content: 'PRIVATE' }
            : input.family === 'event'
              ? { summary: titles.event, cognitiveTransition: 'PRIVATE' }
              : input.family === 'thread_overview'
                ? { title: titles.thread_overview, summary: 'PRIVATE' }
                : input.family === 'person_memory'
                  ? { displayName: titles.person_entity, provenanceRefs: [], facts: ['PRIVATE'] }
                  : { claim: 'PRIVATE', sourceRunId: 'PRIVATE' };
      return { status: 'ok', payload };
    },
  };
  const views = await readViews(reader);
  assert.equal(views.length, RECALL_RESOLVER_FAMILIES.length);
  for (const family of RECALL_RESOLVER_FAMILIES) {
    const view = views.find((item) => item.cueId === `${family}-r1`);
    assert.equal(view?.title, titles[family]);
    assert.equal(view?.invocationId, 'inv');
    assert.equal(view?.sourceRevision, 'r1');
  }
  assert.ok(!JSON.stringify(views).includes('PRIVATE'));
});

it('uses exact cue revisions, excludes foreign owner/thread rows and separates read failure', async () => {
  seed('taste', 'same', 'r1');
  seed('taste', 'same', 'r2');
  seed('taste', 'same', 'r3');
  seed('taste', 'foreign', 'foreign-owner', 'other');
  seed('taste', 'foreign', 'foreign-thread', 'owner', 'other');
  const seen: string[] = [];
  const views = await readViews({
    async read(input) {
      seen.push(input.expectedRevision);
      if (input.expectedRevision === 'r2') return { status: 'not_available', invalidationReason: 'source_corrected' };
      if (input.expectedRevision === 'r3') throw new Error('temporary failure');
      return { status: 'ok', payload: { vignette: { when: titles.taste } } };
    },
  });
  assert.deepEqual(seen.sort(), ['r1', 'r2', 'r3']);
  assert.equal(views.find((item) => item.sourceRevision === 'r1')?.title, titles.taste);
  for (const revision of ['r2', 'r3']) {
    const view = views.find((item) => item.sourceRevision === revision);
    assert.equal(view?.title, undefined);
    assert.equal(view?.titleStatus, 'unavailable');
    assert.equal(view?.href, null);
  }
});

it('does not use a cue reader to bypass a private evidence index lane', async () => {
  seed('project_knowledge', 'PRIVATE');
  db.prepare('INSERT INTO evidence_docs VALUES (?,?,?,?,?)').run('PRIVATE', 'secret', 'feature', 'library', null);
  const views = await readViews({
    read: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(views[0]?.title, undefined);
  assert.equal(views[0]?.href, null);
});

it('shows a content-free seed delivery description without opening its cat-private body', async () => {
  seed('cat_owned_seed', 'owned-seed:sonnet:private');
  const views = await readViews({
    read: async () => {
      assert.fail('must not impersonate the producing cat');
    },
  });
  assert.equal(views[0]?.title, titles.cat_owned_seed);
  assert.equal(views[0]?.href, null);
});

it('reads the title from taste task-bundle and dimension payloads without quotes or paths', async () => {
  seed('taste', 'bundle', 'r1');
  seed('taste', 'dimensions', 'r2');
  const views = await readViews({
    async read(input) {
      return {
        status: 'ok',
        payload:
          input.anchor === 'bundle'
            ? { vignette: { sourcePath: 'PRIVATE', payload: { when: '任务里的品味', quotes: ['PRIVATE'] } } }
            : { vignettes: [{ payload: { when: '第一条品味' } }, { payload: { when: '第二条品味' } }] },
      };
    },
  });
  assert.equal(views.find((item) => item.anchor === 'bundle')?.title, '任务里的品味');
  assert.equal(views.find((item) => item.anchor === 'dimensions')?.title, '第一条品味；第二条品味');
  assert.ok(!JSON.stringify(views).includes('PRIVATE'));
});

it('projects an actual approved ELI5 vignette through the canonical owner and revision reader', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f321-title-taste-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = 'docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md';
  mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  writeFileSync(
    join(root, sourcePath),
    `---
when: "提到 ELI5 时先讲直觉"
quotes: ["PRIVATE quote"]
scene: "PRIVATE scene"
tags: [ELI5, HTML富文本, 概念对比, 可视化优先]
dimension: visual-quality
privacy: public
catId: codex-sol
proposalId: proposal_test_approved
---
`,
  );
  const source = new CanonicalTasteMemoryCueSource(
    { canonicalRoot: () => root } as ConstructorParameters<typeof CanonicalTasteMemoryCueSource>[0],
    'owner',
  );
  const projection = await source.resolveExplicit({ ownerUserId: 'owner', triggerKey: 'ELI5' });
  assert.ok(projection);
  seed('taste', `taste-vignette:${sourcePath}`, projection.revision);
  const views = await readViews({
    read: (input) =>
      source.read({
        ownerUserId: input.scope.ownerUserId,
        anchor: input.anchor,
        expectedRevision: input.expectedRevision,
      }),
  });
  assert.equal(views[0]?.title, titles.taste);
  assert.ok(!JSON.stringify(views).includes('PRIVATE'));
});
