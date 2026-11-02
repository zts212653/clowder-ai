import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexicalMessagePassages } from '../../dist/domains/memory/message-passage-lexical.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const lower = '2026-10-25T00:08:00Z';
const upper = '2026-10-25T00:09:00Z';
const dated = [
  ['before', '2026-10-25T00:07:00Z'],
  ['lower', lower],
  ['middle', '2026-10-25T00:08:30Z'],
  ['upper', upper],
  ['after', '2026-10-25T00:10:00Z'],
];

async function fixture(t) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  await store.upsert(
    ['visible', 'private'].map((name) => ({
      anchor: `thread-${name}`,
      kind: 'thread',
      status: 'active',
      title: name,
      updatedAt: lower,
    })),
  );
  const db = store.getDb();
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 256; i++)
      insert.run('thread-visible', `msg-old-${i}`, `柚子酸甜旧记录${i}${'甲'.repeat(4000)}`, '2026-01-01T00:00:00Z');
    for (let i = 0; i < 32; i++) insert.run('thread-private', `msg-private-${i}`, `柚子酸甜私有记录${i}`, lower);
    for (const [id, date] of dated) insert.run('thread-visible', `msg-${id}`, `柚子酸甜${id}`, date);
    insert.run('thread-visible', 'note-non-message', '柚子酸甜非消息正文', lower);
  })();
  let calls = 0;
  let oldBodyCalls = 0;
  let bodyUnits = 0;
  const original = db.function;
  db.function = function (name, options, fn) {
    return original.call(
      this,
      name,
      options,
      name === 'message_cjk_match'
        ? (content) => {
            calls++;
            bodyUnits += content.length;
            if (content.includes('旧记录')) oldBodyCalls++;
            return fn(content);
          }
        : fn,
    );
  };
  return { db, cost: () => ({ calls, oldBodyCalls, bodyUnits }) };
}

for (const sort of ['time', 'relevance']) {
  for (const range of [
    { dateFrom: lower },
    { dateTo: upper, dateFrom: lower },
    { dateFrom: upper },
    { dateTo: '2025-12-31T23:59:59Z' },
  ]) {
    test(`CJK ${sort} applies ${JSON.stringify(range)} before visiting rejected message bodies`, async (t) => {
      const { db, cost } = await fixture(t);
      const options = { sort, ...range, excludeSource: { threadId: 'visible', messageId: 'middle' } };
      const rows = lexicalMessagePassages(db, '柚子 酸甜', options, new Set(['thread-visible']), 2000);
      const eligible = dated.filter(
        ([id, date]) =>
          id !== 'middle' && (!range.dateFrom || date >= range.dateFrom) && (!range.dateTo || date <= range.dateTo),
      );
      assert.deepEqual(new Set(rows.map((row) => row.passageId)), new Set(eligible.map(([id]) => `msg-${id}`)));
      assert.equal(cost().calls, eligible.length, 'only date/source/type/visibility-admitted bodies reach the matcher');
      assert.equal(cost().oldBodyCalls, 0, 'historical bodies outside the range are not normalized');
      t.diagnostic(JSON.stringify(cost()));
    });
  }
}

test('CJK filter binds remain identical with many grants, phrase parameters and both date bounds', async (t) => {
  const { db, cost } = await fixture(t);
  const anchors = new Set(Array.from({ length: 2405 }, (_, i) => `thread-unused-${i}`));
  anchors.add('thread-visible');
  const rows = lexicalMessagePassages(
    db,
    '柚子 酸甜',
    {
      sort: 'relevance',
      dateFrom: lower,
      dateTo: upper,
      excludeSource: { threadId: 'visible', messageId: 'middle' },
    },
    anchors,
    1,
  );
  assert.equal(rows.length, 2, 'pool+1 truncation witness is preserved');
  assert.deepEqual(new Set(rows.map((row) => row.passageId)), new Set(['msg-lower', 'msg-upper']));
  assert.equal(cost().calls, 2);
});
