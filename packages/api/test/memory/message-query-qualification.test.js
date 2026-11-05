import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import {
  candidateKey,
  contentRevision,
  literalQueryEvidence,
  parseQualification,
  qualificationBatch,
  qualificationSchedulingScore,
} from '../../dist/domains/memory/message-query-protocol.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';

const row = (id, content = `Old pack was swapped ${id}`) => ({
  threadId: 'visible',
  messageId: id,
  content,
  contentRevision: contentRevision(content),
});
const reply = (batch) =>
  JSON.stringify({ requestId: batch.requestId, rows: batch.rows.map((item) => [item.id, 'supported', item.body]) });
const context = () => ({ userId: 'owner', deadlineAt: Date.now() + 5000 });

test('literal admission is one complete word or exact historical body, never a multi-term AND', () => {
  assert.equal(literalQueryEvidence('piano', 'A piano discussion'), 'piano');
  assert.equal(literalQueryEvidence('piano', 'pianola discussion'), null);
  assert.equal(literalQueryEvidence('Mira 起名', '给 Mira 起名的原始讨论'), null);
  assert.equal(literalQueryEvidence('Mira 起名', 'Mira 起名'), 'Mira 起名');
  assert.equal(literalQueryEvidence('Ari 向 Bex 转交文稿', 'Bex 向 Ari 转交文稿'), null);
});

test('query/revision binding, duplicate IDs and unknown IDs cannot publish model output', () => {
  const batch = qualificationBatch('battery replacement', [row('a')]);
  assert.throws(() => parseQualification(JSON.stringify({ requestId: 'other-query', rows: [] }), batch));
  assert.throws(() =>
    parseQualification(
      JSON.stringify({ requestId: batch.requestId, rows: [['unknown', 'supported', batch.rows[0].body]] }),
      batch,
    ),
  );
  assert.throws(() =>
    parseQualification(
      JSON.stringify({
        requestId: batch.requestId,
        rows: [
          ['c0', 'rejected', null],
          ['c0', 'supported', batch.rows[0].body],
        ],
      }),
      batch,
    ),
  );
  const changed = structuredClone(batch);
  changed.rows[0].body = 'Changed body';
  assert.throws(() => parseQualification(reply(changed), changed), /Changed qualification body/);
});

test('Host validates exact Unicode quotes; missing, fabricated and ambiguous evidence stays unassessed', () => {
  const candidates = [row('unicode', '🦊 文稿已找回。'), row('twice', 'same same'), row('missing')];
  const batch = qualificationBatch('document recovery', candidates);
  const actual = parseQualification(
    JSON.stringify({
      requestId: batch.requestId,
      rows: [
        ['c0', 'supported', '🦊 文稿'],
        ['c1', 'supported', 'same'],
      ],
    }),
    batch,
  );
  assert.equal(actual.get(candidateKey(candidates[0])), 'supported');
  assert.equal(actual.size, 1);
  assert.equal(
    parseQualification(JSON.stringify({ requestId: batch.requestId, rows: [['c0', 'supported', 'invented']] }), batch)
      .size,
    0,
  );
});

test('whole long bodies and 64-row calls are bounded without shrinking the input pool or treating overflow as rejected', async () => {
  const calls = [];
  const qualifier = new MessageQueryQualifier(async (batch) => {
    calls.push(batch);
    return reply(batch);
  });
  const candidates = [row('too-long', 'x'.repeat(64_001)), ...Array.from({ length: 130 }, (_, i) => row(String(i)))];
  const actual = await qualifier.qualify('battery replacement', candidates, context());
  assert.equal(calls.length, 2);
  assert.ok(calls.every((batch) => batch.rows.length <= 64));
  assert.ok(calls.flatMap((batch) => batch.rows).reduce((n, r) => n + r.body.length, 0) <= 64_000);
  assert.equal(actual.meta.examined, 131);
  assert.equal(actual.meta.supported, 128);
  assert.equal(actual.meta.unassessed, 3);
  assert.equal(actual.meta.rejected, 0);
  assert.equal(actual.meta.status, 'partial');
});

test('all service instances share two Host slots; a third query stays partial without queueing or a hidden retry', async () => {
  const releases = [];
  let current = 0;
  let maximum = 0;
  let calls = 0;
  const run = async (batch) => {
    calls++;
    current++;
    maximum = Math.max(maximum, current);
    await new Promise((resolve) => releases.push(resolve));
    current--;
    return reply(batch);
  };
  const one = new MessageQueryQualifier(run).qualify('battery replacement', [row('a')], context());
  const two = new MessageQueryQualifier(run).qualify('battery replacement', [row('b')], context());
  const three = await new MessageQueryQualifier(run).qualify('battery replacement', [row('c')], context());
  assert.equal(calls, 2);
  assert.equal(three.meta.unassessed, 1);
  for (const release of releases) release();
  await Promise.all([one, two]);
  assert.equal(maximum, 2);
});

test('cancellation reaches the native runner and does not release capacity before teardown', async () => {
  const controller = new AbortController();
  let stopped = false;
  const qualifier = new MessageQueryQualifier(async (_batch, ctx) => {
    await new Promise((resolve) => ctx.signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true }));
    stopped = true;
    return '{}';
  });
  const pending = qualifier.qualify('battery replacement', [row('a')], { ...context(), signal: controller.signal });
  controller.abort(new DOMException('client closed', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, true);
});

test('provider deadlines reserve publication time and leave unfinished rows unassessed', async () => {
  let stopped = false;
  const qualifier = new MessageQueryQualifier(async (_batch, ctx) => {
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    stopped = true;
    return '{}';
  });
  const actual = await qualifier.qualify('battery replacement', [row('a')], {
    userId: 'owner',
    deadlineAt: Date.now() + 2050,
  });
  assert.equal(stopped, true);
  assert.equal(actual.meta.unassessed, 1);
  assert.equal(actual.meta.rejected, 0);
});

function serviceFixture(duringInference = () => {}) {
  const thread = { id: 'visible', createdBy: 'system', title: 'Shared source' };
  let granted = true;
  const target = {
    id: 'a',
    threadId: thread.id,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'Old pack was swapped',
    timestamp: 1000,
  };
  const source = { ...target, id: 'question', content: 'battery replacement' };
  const messages = new Map([
    ['a', target],
    ['question', source],
  ]);
  const candidate = {
    threadId: thread.id,
    messageId: 'a',
    docAnchor: 'thread-visible',
    passageId: 'msg-a',
    content: target.content,
    match: 'semantic',
  };
  const seen = [];
  const qualifier = new MessageQueryQualifier(async (batch) => {
    seen.push(batch);
    duringInference({
      target,
      source,
      revoke: () => {
        granted = false;
      },
    });
    return reply(batch);
  });
  const service = new MessageSearchService({
    qualifier,
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async () => ({
        passages: [candidate],
        meta: { effectiveMode: 'hybrid', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: true },
      }),
    },
    threadStore: { get: () => thread, list: () => (granted ? [thread] : []) },
    messageStore: { getById: (id) => messages.get(id) },
  });
  return {
    service,
    seen,
    messages,
    candidate,
    principal: { userId: 'owner', viewer: { type: 'user' } },
    input: { query: 'battery replacement', mode: 'hybrid', sort: 'time', limit: 3 },
  };
}

for (const [change, mutate] of [
  [
    'withdrawal',
    ({ target }) => {
      target.deletedAt = 2000;
    },
  ],
  [
    'revision change',
    ({ target }) => {
      target.content = 'A different object was replaced';
    },
  ],
  [
    'owner change',
    ({ target }) => {
      target.userId = 'someone-else';
    },
  ],
  ['grant revocation', ({ revoke }) => revoke()],
])
  test(`publication re-admits ${change} after the model returns`, async () => {
    const f = serviceFixture(mutate);
    const response = await f.service.search(f.input, f.principal);
    assert.equal(f.seen.length, 1);
    assert.deepEqual(response.results, []);
    assert.equal(response.meta.qualification.supported, 0);
    assert.equal(response.meta.qualification.unassessed, 1);
    assert.equal(response.meta.qualification.status, 'partial');
  });

test('a revoked authenticated source cannot publish a returned qualification', async () => {
  const f = serviceFixture(({ source }) => {
    source.deletedAt = 2000;
  });
  await assert.rejects(
    f.service.search(f.input, { ...f.principal, source: { threadId: 'visible', messageId: 'question' } }),
    /source.*not accessible/,
  );
});

test('semantic evidence deep in a long original body supplies the visible excerpt without invented query highlights', async () => {
  const f = serviceFixture();
  const body = `${'Unrelated paragraph. '.repeat(200)}Old pack was swapped`;
  f.messages.get('a').content = body;
  f.candidate.content = body;
  const { MessageQueryQualifier } = await import('../../dist/domains/memory/message-query-qualifier.js');
  // Use the real protocol with an exact quote, as the native carrier must return.
  f.service = new MessageSearchService({
    qualifier: new MessageQueryQualifier(async (batch) =>
      JSON.stringify({ requestId: batch.requestId, rows: [[batch.rows[0].id, 'supported', 'Old pack was swapped']] }),
    ),
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async () => ({
        passages: [f.candidate],
        meta: { effectiveMode: 'hybrid', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: true },
      }),
    },
    threadStore: {
      get: () => ({ id: 'visible', createdBy: 'owner' }),
      list: () => [{ id: 'visible', createdBy: 'owner' }],
    },
    messageStore: { getById: (id) => f.messages.get(id) },
  });
  const response = await f.service.search(f.input, f.principal);
  const hit = response.results[0];
  assert.ok(hit.snippet.text.includes('Old pack was swapped'));
  assert.equal(body.slice(hit.snippet.start, hit.snippet.end), hit.snippet.text);
  assert.deepEqual(hit.highlights, []);
});

test('page-sized qualification schedules literal clues but never promotes them to support or deletes the remaining pool', async () => {
  const calls = [];
  const qualifier = new MessageQueryQualifier(async (batch) => {
    calls.push(batch);
    return JSON.stringify({
      requestId: batch.requestId,
      rows: batch.rows.map((r) => [
        r.id,
        r.body.includes('Sol 命名') ? 'rejected' : 'supported',
        r.body.includes('Sol 命名') ? null : r.body,
      ]),
    });
  });
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => row('semantic-' + i, 'The solar namesake ' + i)),
    row('literal-neighbor', 'Sol 命名: an unrelated quoted question'),
  ];
  const result = await qualifier.qualify('Sol 命名', rows, { ...context(), resultLimit: 3 });
  assert.equal(calls.length, 2);
  assert.equal(calls.flatMap((b) => b.rows).length, 4);
  assert.ok(calls.flatMap((b) => b.rows).some((r) => r.messageId === 'literal-neighbor'));
  assert.equal(result.decisions.get(candidateKey(rows.at(-1))), 'rejected');
  assert.equal(result.meta.examined, 13);
  assert.equal(result.meta.unassessed, 9);
  assert.equal(result.meta.status, 'partial');
  assert.deepEqual(
    rows.map((r) => r.messageId),
    [...Array.from({ length: 12 }, (_, i) => 'semantic-' + i), 'literal-neighbor'],
  );
});

test('budget scheduling distinguishes whole neutral names from Latin substrings without signing a judgment', () => {
  const score = qualificationSchedulingScore('Neri 命名');
  assert.equal(score('Nerita compiler 命名'), 1);
  assert.equal(score('给 Neri 命名'), 2);
  assert.equal(score('A wholly semantic paraphrase'), 0);
});
