import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexicalMessagePassages } from '../../dist/domains/memory/message-passage-lexical.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const natural = '请完整保留这段合成问题中的全部文字并寻找原始依据，同时保留排序来源权限和停止边界以便复核实际结果';

async function fixture(t, count = 8192) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const db = store.getDb();
  await store.upsert([
    { anchor: 'thread-visible', kind: 'thread', status: 'active', title: 'neutral', updatedAt: '2026-01-01' },
  ]);
  const put = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('thread-visible',?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++)
      put.run(`msg-noise-${i}`, `中性正文甲乙丙丁${'戊己庚辛'.repeat(265)}`, '2026-01-01');
    // The exact hit is beyond every small result pool, inside a continuous CJK
    // token that unicode61 cannot recover as a full FTS token.
    put.run('msg-late', `壬${natural}癸`, '2026-01-01');
    put.run('msg-prefix-only', `${natural.slice(0, 24)}替换其余问题`, '2026-01-01');
  })();
  return { db, put };
}

for (const sort of ['time', 'relevance']) {
  test(`a long natural CJK ${sort} read avoids moving every nonmatching body into JavaScript`, async (t) => {
    const { db } = await fixture(t);
    let last;
    const grants = new Set(Array.from({ length: 2650 }, (_, i) => `thread-absent-${i}`));
    grants.add('thread-visible');
    const rows = lexicalMessagePassages(
      db,
      natural,
      { sort, excludeSource: { threadId: 'visible', messageId: 'none' }, onCjkRead: (s) => (last = s) },
      grants,
      1,
    );
    assert.deepEqual(
      rows.map((r) => r.passageId),
      ['msg-late'],
    );
    assert.equal(last.complete, true);
    assert.equal(last.outcome, 'fulfilled');
    assert.equal(last.returnedRows, 1);
    assert.ok(last.bodyVisits <= 2, `nonmatching corpus exhausted JS body work: ${last.bodyVisits}`);
    assert.ok(last.bodyUtf16 < 1000, `nonmatching corpus was transferred to the matcher: ${last.bodyUtf16}`);
  });
}

test('necessary CJK filtering preserves all alternatives, ASCII folding and literal punctuation', async (t) => {
  const { db, put } = await fixture(t, 0);
  const terms = ['前段甲.*乙', '中段猫🐾', 'ABC末段Case', "终段'戊[己]"];
  db.transaction(() => {
    for (let i = 0; i < terms.length; i++) put.run(`msg-hit-${i}`, `壬${terms[i]}癸`, '2026-01-01');
    put.run('msg-regex-only', '前段甲其他字符乙', '2026-01-01');
    put.run('msg-wrong-casefold', '不含完整拉丁字边界末段', '2026-01-01');
  })();
  const rows = lexicalMessagePassages(db, terms.join(' '), { sort: 'relevance' }, new Set(['thread-visible']), 20);
  assert.deepEqual(new Set(rows.map((r) => r.passageId)), new Set(terms.map((_v, i) => `msg-hit-${i}`)));
});

test('long shared prefixes are not shortened into term hits', async (t) => {
  const { db, put } = await fixture(t, 0);
  const words = ['甲', '乙', '丙'].map((last) => '中'.repeat(664) + last);
  put.run('msg-common-prefix', '中'.repeat(1024), '2026-01-01');
  put.run('msg-final-term', `壬${words.at(-1)}癸`, '2026-01-01');
  const rows = lexicalMessagePassages(db, words.join(' '), { sort: 'relevance' }, new Set(['thread-visible']), 1);
  assert.equal(rows[0].passageId, 'msg-final-term');
  assert.equal(rows.length, 1);
});

for (const sort of ['time', 'relevance']) {
  test(`a wide legal ${sort} grant set keeps the existing SQLite bind budget`, async (t) => {
    const { db, put } = await fixture(t, 0);
    put.run('msg-wide-grants', '前甲后', '2026-01-01');
    const option = db.pragma('compile_options').find((row) => row.compile_options.startsWith('MAX_VARIABLE_NUMBER='));
    const cap = Number(option.compile_options.split('=')[1]);
    // The original FTS query needs two phrase values, MATCH, source exclusion
    // and LIMIT in addition to grants. CJK preparation must not exceed it.
    const grants = new Set(Array.from({ length: cap - 7 }, (_, i) => `thread-unused-${i}`));
    grants.add('thread-visible');
    const rows = lexicalMessagePassages(
      db,
      '甲 乙 丙 丁',
      { sort, excludeSource: { threadId: 'visible', messageId: 'none' } },
      grants,
      1,
    );
    assert.equal(rows[0].passageId, 'msg-wide-grants');
  });
}
