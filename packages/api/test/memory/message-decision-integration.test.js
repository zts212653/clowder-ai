import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageSearchAccessError, MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { buildSearchableMessageContent } from '../../dist/domains/memory/message-search-content.js';
import { projectCanonicalSearchMessage } from '../../dist/domains/memory/message-search-projection.js';
import { registerMessageNavigationSourceRoute } from '../../dist/routes/message-navigation-source-route.js';

const principal = { userId: 'owner', viewer: { type: 'user' } };
const sourceId = '0001792080484605-000020-360a81d7';
const fact = {
  status: 'decided',
  conclusion: '标题最多两行',
  featureId: 'F322',
  documentPath: 'docs/features/F322-everyday-work-experience.md',
  documentRevision: 'a'.repeat(40),
  line: 314,
  decidedBy: 'You',
  decidedAt: '10-15 09:08',
};
function fixture(decisionIndex) {
  const source = {
    id: sourceId,
    threadId: 'visible',
    userId: 'owner',
    catId: null,
    content: 'piano 原文完整正文。',
    timestamp: 1000,
  };
  const following = [
    { ...source, id: 'after', catId: 'codex61-sol', content: '后续回应。', timestamp: 2000 },
    {
      ...source,
      id: 'internal',
      from: { kind: 'system', service: 'internal' },
      catId: 'system',
      content: 'private lifecycle',
      timestamp: 3000,
    },
  ];
  const messages = new Map([source, ...following].map((m) => [m.id, m]));
  const thread = { id: 'visible', title: '原对话', createdBy: 'owner' };
  const deps = {
    qualifier: new MessageQueryQualifier(async (batch) =>
      JSON.stringify({
        requestId: batch.requestId,
        rows: batch.rows.map((row) => [row.id, 'supported', row.body]),
      }),
    ),
    evidenceStore: {
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: async () => ({
        passages: [
          {
            threadId: source.threadId,
            messageId: source.id,
            passageId: `msg-${source.id}`,
            docAnchor: 'thread-visible',
            content: source.content,
            speaker: 'user',
            match: 'lexical',
            createdAt: '2026-10-15',
          },
        ],
        meta: {
          degraded: false,
          effectiveMode: 'lexical',
          sort: 'time',
          candidateLimit: 2000,
          truncated: false,
          semanticCandidatesLimited: false,
          sourceCoverage: 'unknown',
          freshness: 'unknown',
        },
      }),
    },
    threadStore: { get: (id) => (id === thread.id ? thread : null), list: () => [thread] },
    messageStore: { getById: (id) => messages.get(id) ?? null, getByThreadAfter: async () => following },
    decisionIndex,
  };
  return { service: new MessageSearchService(deps), source, thread, messages, deps };
}

test('the common search attaches only exact admitted ledger sources, without replacing snippets or results', async () => {
  let refs;
  const f = fixture({
    lookup: async (rows) => {
      refs = rows;
      return {
        status: 'ready',
        revision: 'a'.repeat(40),
        facts: new Map([
          [`visible:${sourceId}`, [fact]],
          ['another:hidden', [{ ...fact, conclusion: 'PRIVATE' }]],
        ]),
      };
    },
  });
  const result = await f.service.search({ query: 'piano', mode: 'lexical' }, principal);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].decisionSources, [fact]);
  assert.equal(result.results[0].snippet.text, f.source.content);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].messageId, sourceId);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('a ledger I/O delay cannot keep a withdrawn or revised source alive at publication', async () => {
  let f;
  f = fixture({
    lookup: async () => {
      f.source.content = 'changed while the ledger was being read';
      return { status: 'ready', facts: new Map([[`visible:${sourceId}`, [fact]]]) };
    },
  });
  const result = await f.service.search({ query: 'piano', mode: 'lexical' }, principal);
  assert.deepEqual(result.results, []);
  assert.equal(result.meta.qualification.unassessed, 1);
});

test('structured human quotes display the original text and comment, not the transport JSON or source metadata', async () => {
  const f = fixture();
  f.source.content =
    '@opus55 你看看\n<context_attachments>[{"text":"侧栏标题要一行？","comment":"不要一行这种","source":{"messageId":"private-metadata"}}]</context_attachments>';
  f.source.contentBlocks = [
    { type: 'text', text: '@opus55 你看看' },
    {
      type: 'context_attachment',
      attachment: {
        v: 1,
        id: 'ctx-1',
        kind: 'quote',
        text: '侧栏标题要一行？',
        comment: '不要一行这种',
        source: { kind: 'message', threadId: 'visible', messageId: 'private-metadata' },
      },
    },
  ];
  const source = await f.service.resolveNavigationReference({ threadId: 'visible', messageId: sourceId }, principal, 0);
  assert.equal(source.message.content, '@opus55 你看看\n\n侧栏标题要一行？\n\n不要一行这种');
  assert.ok(!source.message.content.includes('private-metadata'));
  assert.ok(!source.message.content.includes('context_attachments'));
});

test('an attachment-only callback retains the separate spoken body in its source text', async () => {
  const f = fixture();
  f.source.content = '我同意继续保留两行。';
  f.source.contentBlocks = [
    {
      type: 'context_attachment',
      attachment: {
        v: 1,
        id: 'ctx-body',
        kind: 'quote',
        text: '侧栏标题的原提议',
        comment: '对照这一段',
        source: { kind: 'message', threadId: 'visible', messageId: 'old' },
      },
    },
  ];
  const result = await f.service.resolveNavigationReference({ threadId: 'visible', messageId: sourceId }, principal, 0);
  assert.equal(result.message.content, '我同意继续保留两行。\n\n侧栏标题的原提议\n\n对照这一段');
});

test('structured excerpts retain the actual qualified evidence, including when it cannot map to a displayed field', () => {
  const f = fixture();
  f.source.content =
    '你看看\n<context_attachments>[{"text":"标题要一行？","comment":"不要一行这种"}]</context_attachments>';
  f.source.contentBlocks = [
    { type: 'text', text: '你看看' },
    {
      type: 'context_attachment',
      attachment: {
        v: 1,
        id: 'ctx-excerpt',
        kind: 'quote',
        text: '标题要一行？',
        comment: '不要一行这种',
        source: { kind: 'message', threadId: 'visible', messageId: 'before' },
      },
    },
  ];
  const canonical = buildSearchableMessageContent(f.source);
  const candidate = {
    threadId: 'visible',
    messageId: sourceId,
    content: canonical,
    passageId: `msg-${sourceId}`,
    docAnchor: 'thread-visible',
    match: 'lexical',
  };
  const project = (evidence) =>
    projectCanonicalSearchMessage(f.source, f.thread, { current: true }, candidate, '一行', evidence);
  assert.ok(project('\n不要一行这种').result.snippet.text.includes('不要一行这种'));
  const exact = '"comment":"不要一行这种"';
  assert.ok(
    project(exact).result.snippet.text.includes(exact),
    'presentation cannot replace qualified evidence with unrelated opening words',
  );
});

test('context reads validate coordinates, identity and source again after successors have been read', async () => {
  const f = fixture();
  const app = Fastify();
  registerMessageNavigationSourceRoute(app, f.service);
  const url = `/api/evidence/navigation-source?threadId=visible&messageId=${sourceId}&contextCount=3`;
  const headers = { 'x-cat-cafe-user': 'owner' };
  try {
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/evidence/navigation-source?threadId=visible&contextCount=3',
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    f.deps.messageStore.getByThreadAfter = async () => {
      f.source.deletedAt = 5;
      return [];
    };
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 404);
    f.source.deletedAt = undefined;
    f.deps.messageStore.getByThreadAfter = async () => {
      f.thread.createdBy = 'other';
      return [];
    };
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 403);
  } finally {
    await app.close();
  }
});

test('an aborted source read cannot publish a cached canonical body', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.deps.messageStore.getByThreadAfter = async () => {
    controller.abort();
    return [];
  };
  await assert.rejects(
    f.service.resolveNavigationReference({ threadId: 'visible', messageId: sourceId }, principal, 3, controller.signal),
    { name: 'AbortError' },
  );
});

test('optional decision metadata cannot evict an otherwise admitted search result from its response budget', async () => {
  const f = fixture({
    lookup: async () => ({
      status: 'ready',
      facts: new Map([
        [
          `visible:${sourceId}`,
          Array.from({ length: 80 }, (_, i) => ({ ...fact, line: i + 1, conclusion: '已定事项'.repeat(120) })),
        ],
      ]),
    }),
  });
  const result = await f.service.search({ query: 'piano', mode: 'lexical' }, principal);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].messageId, sourceId);
  assert.equal(result.results[0].decisionSources, undefined);
  assert.equal(result.meta.decisionIndex.status, 'unavailable');
});

test('literal results re-admit the authenticated invocation source after the document lookup', async () => {
  let f;
  f = fixture({
    lookup: async () => {
      f.messages.delete('ingress');
      return { status: 'ready', facts: new Map() };
    },
  });
  f.messages.set('ingress', { ...f.source, id: 'ingress', content: 'current authenticated request' });
  await assert.rejects(
    f.service.search(
      { query: 'piano', mode: 'lexical' },
      { ...principal, source: { threadId: 'visible', messageId: 'ingress' } },
    ),
    MessageSearchAccessError,
  );
});

test('a failed ledger read is explicitly unavailable and does not turn the search into a failure or invented decision', async () => {
  const f = fixture({
    lookup: async () => {
      throw new Error('document unavailable');
    },
  });
  const result = await f.service.search({ query: 'piano', mode: 'lexical' }, principal);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].decisionSources, undefined);
  assert.equal(result.meta.decisionIndex.status, 'unavailable');
});

test('the existing source route can return canonical text and bounded readable successors without navigating', async () => {
  const f = fixture();
  const app = Fastify();
  registerMessageNavigationSourceRoute(app, f.service);
  try {
    const r = await app.inject({
      method: 'GET',
      url: `/api/evidence/navigation-source?threadId=visible&messageId=${sourceId}&contextCount=3`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.message.content, f.source.content);
    assert.equal(body.message.messageId, sourceId);
    assert.deepEqual(
      body.following.map((x) => x.messageId),
      ['after'],
    );
    assert.ok(!r.body.includes('private lifecycle'));
    f.source.deletedAt = 4000;
    const gone = await app.inject({
      method: 'GET',
      url: `/api/evidence/navigation-source?threadId=visible&messageId=${sourceId}&contextCount=3`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(gone.statusCode, 404);
    f.source.deletedAt = undefined;
    f.thread.createdBy = 'another-owner';
    const denied = await app.inject({
      method: 'GET',
      url: `/api/evidence/navigation-source?threadId=visible&messageId=${sourceId}&contextCount=3`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await app.close();
  }
});
