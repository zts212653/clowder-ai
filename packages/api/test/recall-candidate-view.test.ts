import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import Database from 'better-sqlite3';
import { recallCandidateViewReader } from '../src/routes/recall-candidate-view.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE evidence_docs (anchor TEXT, title TEXT, kind TEXT, collection_id TEXT, world_id TEXT)');
});
afterEach(() => db.close());
const stores = {
  threadStore: {
    async get(id: string) {
      return id === 'thread-owned'
        ? { id, createdBy: 'owner', title: '真实对话标题' }
        : { id, createdBy: 'other', title: '不可泄漏的标题' };
    },
    async list() {
      return [];
    },
  },
  personMemoryStore: {
    async getPerson(owner: string, id: string) {
      return {
        ownerUserId: owner,
        displayName: '真实人物名字',
        status: id === 'person_retired' ? ('retired' as const) : ('active' as const),
      };
    },
  },
};
it('resolves owned thread titles and only gives an exact readable target a link', async () => {
  const read = recallCandidateViewReader(db, 'owner', stores);
  assert.deepEqual(await read('thread-thread-owned'), {
    title: '真实对话标题',
    kind: 'thread',
    href: '/thread/thread-owned',
  });
  assert.deepEqual(await read('thread-thread-foreign'), { kind: 'thread', href: null });
});
it('uses the owner-scoped person reader and hides retired or foreign identities', async () => {
  const read = recallCandidateViewReader(db, 'owner', stores);
  assert.deepEqual(await read('person-memory:person_active'), {
    title: '真实人物名字',
    kind: 'person_entity',
    href: null,
  });
  assert.deepEqual(await read('person-memory:person_retired'), { kind: 'person_entity', href: null });
  const foreign = recallCandidateViewReader(db, 'owner', {
    personMemoryStore: { getPerson: async () => ({ ownerUserId: 'other', displayName: 'private', status: 'active' }) },
  });
  assert.deepEqual(await foreign('person-memory:person_active'), { kind: 'person_entity', href: null });
});
it('never supplies an unresolved/private library anchor as a display title or destination', async () => {
  db.prepare('INSERT INTO evidence_docs VALUES (?,?,?,?,?)').run(
    'PRIVATE',
    'private title',
    'feature',
    'private-library',
    'private-world',
  );
  assert.deepEqual(await recallCandidateViewReader(db, 'owner', stores)('PRIVATE'), { href: null });
});

it('retains a known source type when its reader fails without exposing an id or link', async () => {
  const read = recallCandidateViewReader(db, 'owner', {
    threadStore: {
      get: async () => {
        throw new Error('unavailable');
      },
      list: async () => [],
    },
  });
  assert.deepEqual(await read('thread-thread-owned'), { kind: 'thread', href: null, titleStatus: 'unavailable' });
});

it('resolves plan titles while excluding each private lane and non-document kinds', async () => {
  const insert = db.prepare('INSERT INTO evidence_docs VALUES (?,?,?,?,?)');
  insert.run('PLAN', '真实计划标题', 'plan', null, null);
  insert.run('COLLECTION', 'private collection title', 'feature', 'private', null);
  insert.run('WORLD', 'private world title', 'feature', null, 'private');
  insert.run('SESSION', 'private session title', 'session', null, null);
  const read = recallCandidateViewReader(db, 'owner', stores);
  assert.deepEqual(await read('PLAN'), { title: '真实计划标题', kind: 'plan', href: '/memory/search?q=PLAN' });
  for (const anchor of ['COLLECTION', 'WORLD', 'SESSION']) assert.deepEqual(await read(anchor), { href: null });
});

it('requires system threads in the owner list and hides deleted threads', async () => {
  const read = recallCandidateViewReader(db, 'owner', {
    threadStore: {
      get: async (id) => ({
        id,
        createdBy: 'system',
        title: '共享对话',
        ...(id === 'deleted' ? { deletedAt: 1 } : {}),
      }),
      list: async () => [{ id: 'visible' }, { id: 'deleted' }],
    },
  });
  assert.deepEqual(await read('thread-visible'), { title: '共享对话', kind: 'thread', href: '/thread/visible' });
  for (const id of ['unlisted', 'deleted'])
    assert.deepEqual(await read(`thread-${id}`), { kind: 'thread', href: null });
});
