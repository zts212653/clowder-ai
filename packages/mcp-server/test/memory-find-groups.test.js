/**
 * F332 find unification (F2): messages, graph and recent groups behind cat_cafe_search_evidence. Behaviour that the
 * retired graph and recent tools guaranteed is carried here (KD-8 visibility, resolve-time relation filters, nested
 * subgraph shape, candidates, since/kinds/scope, cross-post suggestions, collection distribution, errors).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseRecallMetaFromText } from '@cat-cafe/shared';

const DOCS = '/api/evidence/search';
const GRAPH = '/api/library/graph/resolve';
const MATTERS = '/api/callbacks/memory-matters';
const MESSAGES = '/api/callbacks/search-evidence';
const RECENT = '/api/library/recent';
const sorted = (...list) => [...list].sort();

const docsHit = {
  title: 'Doc',
  anchor: 'docs/plans/doc.md',
  snippet: 's',
  matchRank: 'high',
  rank: 1,
  sourceType: 'plan',
};
const messagesResponse = (results = [], meta = {}) => ({
  searchId: 'search-1',
  query: 'q',
  results,
  meta: {
    scope: 'global',
    sort: 'relevance',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: false,
    hasMore: false,
    candidateLimit: 20,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: { budgetChars: 24_000, serializedChars: 0, truncated: false, continuation: 'unavailable' },
    ...meta,
  },
});
const message = (i) => ({
  threadId: 'thread_a',
  messageId: `msg-${i}`,
  threadTitle: '守望猫讨论',
  speaker: 'codex',
  timestamp: 1_794_000_000_000,
  timelineOrderAt: 1_794_000_000_000,
  snippet: { text: `守望猫 第${i}条原话`, start: 0, end: 3, source: 'body' },
  highlights: [{ start: 0, end: 3 }],
  match: 'lexical',
  matchEvidence: { kind: 'literal', terms: ['守望猫'] },
  contentRevision: 'a'.repeat(64),
  publiclyQuotable: true,
});
const subgraph = {
  status: 'graph',
  queryKind: 'exact',
  resolvedAnchor: 'F186',
  graph: {
    center: 'F186',
    depth: 1,
    nodes: [
      {
        anchor: 'F186',
        title: 'Center',
        kind: 'feature',
        collectionId: 'project',
        sensitivity: 'internal',
        redacted: false,
        readRef: { kind: 'file', path: 'docs/features/F186.md' },
      },
      {
        anchor: 'F102',
        title: 'Wiki neighbour',
        kind: 'feature',
        collectionId: 'project',
        sensitivity: 'internal',
        redacted: false,
      },
      {
        anchor: 'ADR-1',
        title: 'Doc neighbour',
        kind: 'decision',
        collectionId: 'project',
        sensitivity: 'private',
        redacted: true,
      },
    ],
    edges: [
      { from: 'F186', to: 'F102', relation: 'wikilink' },
      { from: 'F186', to: 'ADR-1', relation: 'doc_link' },
    ],
  },
};

describe('F332 unified find: messages, graph and recent groups', () => {
  let originalEnv;
  let originalFetch;
  let requests;
  let routes;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('CAT_CAFE_')) delete process.env[key];
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'groups-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'groups-test';
    originalFetch = globalThis.fetch;
    requests = [];
    routes = {
      [DOCS]: () => ({ results: [docsHit], degraded: false }),
      [MATTERS]: () => ({ items: [] }),
      [MESSAGES]: () => messagesResponse(),
      [GRAPH]: () => ({ status: 'no_match', queryKind: 'search', query: 'q', message: 'no node', examples: ['F186'] }),
      [RECENT]: () => ({ items: [] }),
    };
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url));
      requests.push({ path: parsed.pathname, params: parsed.searchParams });
      const route = routes[parsed.pathname];
      if (!route) throw new Error(`unexpected ${parsed.pathname}`);
      const body = await route(parsed.searchParams, init);
      if (body instanceof Response) return body;
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  const find = async (input) => (await import('../dist/tools/evidence-tools.js')).handleSearchEvidence(input);
  const text = (result) => result.content.map((block) => block.text ?? '').join('\n');
  const block = (result, group) => {
    const found = result.content.find((entry) => entry.text?.startsWith(`{"group":"${group}"`));
    return found ? JSON.parse(found.text) : undefined;
  };
  const request = (path) => requests.find((entry) => entry.path === path);
  const paths = () => requests.map((entry) => entry.path).sort();

  // ── messages ───────────────────────────────────────────────────────────────

  test('messages: the same query reaches the original message search with thread and time narrowing', async () => {
    routes[MESSAGES] = () => messagesResponse([message(1), message(2)]);
    const result = await find({ query: '守望猫', threadId: 'thread_a', dateFrom: '2026-11-01', dateTo: '2026-11-10' });
    const params = request(MESSAGES).params;
    assert.equal(params.get('q'), '守望猫');
    assert.equal(params.get('resultUnit'), 'message');
    assert.equal(params.get('threadId'), 'thread_a');
    assert.equal(params.get('dateFrom'), '2026-11-01');
    assert.equal(params.get('dateTo'), '2026-11-10');
    assert.equal(params.get('limit'), '5');
    const messages = block(result, 'messages');
    assert.equal(messages.status, 'ok');
    assert.equal(messages.items.length, 2);
    assert.deepEqual(messages.items[0].matchEvidence, { kind: 'literal', terms: ['守望猫'] });
    assert.deepEqual(messages.items[0].readRef, { kind: 'message', threadId: 'thread_a', messageId: 'msg-1' });
    assert.equal(messages.items[0].highlights, undefined);
  });

  test('since becomes the exact lower bound for docs and messages; graph and matters report not_covered', async () => {
    const before = Date.now();
    const result = await find({ query: '守望猫', since: '24h' });
    const docsFrom = Date.parse(request(DOCS).params.get('dateFrom'));
    const messagesFrom = Date.parse(request(MESSAGES).params.get('dateFrom'));
    assert.ok(Math.abs(docsFrom - (before - 86_400_000)) < 5_000);
    assert.equal(docsFrom, messagesFrom);
    assert.deepEqual(paths(), sorted(DOCS, MESSAGES));
    assert.equal(block(result, 'graph').status, 'not_covered');
    assert.equal(block(result, 'matters').status, 'not_covered');
  });

  for (const [input, message] of [
    [{ query: 'x', since: '24h', dateFrom: '2026-11-01' }, /since or dateFrom, not both/],
    [{ query: 'x', since: 'tomorrow' }, /since must be like 7d, 24h/],
    [{ query: 'x', continueGroup: 'graph', matterCursor: 'c' }, /matterCursor continues the matters group only/],
  ]) {
    test(`input error: ${JSON.stringify(input)}`, async () => {
      const result = await find(input);
      assert.equal(result.isError, true);
      assert.match(text(result), message);
      assert.deepEqual(requests, []);
    });
  }

  test('messages continuation reopens the message group alone with its complete arguments', async () => {
    routes[MESSAGES] = () => messagesResponse([message(1)]);
    const result = await find({ query: '守望猫', continueGroup: 'messages', threadId: 'thread_a', limit: 20 });
    assert.deepEqual(paths(), [MESSAGES]);
    assert.equal(request(MESSAGES).params.get('limit'), '20');
    assert.match(result.content[0].text, /docs → not run \(continuation\)/);
    assert.equal(block(result, 'messages').items.length, 1);
  });

  // ── graph ──────────────────────────────────────────────────────────────────

  test('graph: an exact anchor sends depth and relations at resolve time and renders the nested subgraph', async () => {
    routes[GRAPH] = () => subgraph;
    const result = await find({ query: 'F186', graphDepth: 2, graphRelations: ['wikilink', 'doc_link'] });
    const params = request(GRAPH).params;
    assert.equal(params.get('query'), 'F186');
    assert.equal(params.get('depth'), '2');
    assert.equal(params.get('relations'), 'wikilink,doc_link');
    // KD-8: visibility is server-derived; the client never sends collection scope to the resolver.
    for (const key of ['collections', 'callerCollections', 'dimension']) assert.equal(params.get(key), null);
    const graph = block(result, 'graph');
    assert.equal(graph.result, 'subgraph');
    assert.equal(graph.center, 'F186');
    assert.deepEqual(
      graph.edges.map((edge) => edge.relation),
      ['wikilink', 'doc_link'],
    );
    const restricted = graph.nodes.find((node) => node.anchor === 'ADR-1');
    assert.equal(restricted.sensitivity, 'private');
    assert.equal(restricted.readRef, undefined, 'a redacted node never exposes a read coordinate');
    assert.deepEqual(graph.nodes[0].readRef, { kind: 'file', path: 'docs/features/F186.md' });
  });

  test('graph: the relations filter also hides edges and the nodes only they reached', async () => {
    routes[GRAPH] = () => subgraph;
    const graph = block(await find({ query: 'F186', graphRelations: ['wikilink'] }), 'graph');
    assert.deepEqual(
      graph.nodes.map((node) => node.anchor),
      ['F186', 'F102'],
    );
    assert.deepEqual(graph.edges, [{ from: 'F186', to: 'F102', relation: 'wikilink' }]);
  });

  test('graph: a truncated hub subgraph says so and how to narrow', async () => {
    routes[GRAPH] = () => ({ ...subgraph, graph: { ...subgraph.graph, truncated: true } });
    assert.match(
      block(await find({ query: 'F186' }), 'graph').truncated,
      /hub-node degree cap.*graphDepth 1 or graphRelations/,
    );
  });

  test('graph: text returns candidate anchors with match reasons; no match returns examples', async () => {
    routes[GRAPH] = () => ({
      status: 'candidates',
      query: 'harness',
      candidates: [
        {
          anchor: 'F188',
          title: 'Harness',
          kind: 'feature',
          collectionId: 'project',
          sensitivity: 'internal',
          matchReason: 'title',
          snippet: 'x'.repeat(300),
          readRef: { kind: 'file', path: 'docs/features/F188.md' },
        },
      ],
    });
    const candidates = block(await find({ query: 'harness' }), 'graph');
    assert.equal(candidates.result, 'candidates');
    assert.equal(candidates.items[0].match, 'title');
    assert.ok(candidates.items[0].snippet.length <= 161);
    assert.match(candidates.match, /pass one anchor as query/);
    routes[GRAPH] = () => ({
      status: 'no_match',
      queryKind: 'anchor',
      query: 'F999',
      message: 'unknown anchor',
      examples: ['F186'],
    });
    const none = block(await find({ query: 'F999' }), 'graph');
    assert.equal(none.status, 'no_results');
    assert.deepEqual(none.examples, ['F186']);
  });

  test('graph: a resolver error is the graph group failing, never the docs group', async () => {
    routes[GRAPH] = () => new Response('boom', { status: 500 });
    const result = await find({ query: 'F186' });
    assert.equal(result.isError, undefined);
    assert.match(block(result, 'graph').error, /graph resolve failed \(500\)/);
    assert.match(text(result), /Found 1 result/);
  });

  test('graph: an explicit dimension is not covered (KD-8) instead of being widened', async () => {
    const result = await find({ query: 'F186', dimension: 'collection', collections: 'world:x' });
    assert.equal(request(GRAPH), undefined);
    assert.equal(block(result, 'graph').reason, 'collection_scope_unsupported');
  });

  test('graph continuation reopens the graph alone with its depth and relations', async () => {
    routes[GRAPH] = () => subgraph;
    const result = await find({ query: 'F186', continueGroup: 'graph', graphDepth: 3, graphRelations: ['wikilink'] });
    assert.deepEqual(paths(), [GRAPH]);
    assert.equal(request(GRAPH).params.get('depth'), '3');
    assert.equal(block(result, 'graph').status, 'ok');
  });

  // ── recent (browse) ────────────────────────────────────────────────────────

  test('recent: without a query, since, limit, kinds, scope and current thread reach the recent index', async () => {
    process.env.CAT_CAFE_THREAD_ID = 'thread_here';
    await find({ since: '24h', limit: 10, kinds: ['feature', 'decision'], scope: 'docs' });
    assert.deepEqual(paths(), [RECENT]);
    const params = request(RECENT).params;
    assert.equal(params.get('since'), '24h');
    assert.equal(params.get('limit'), '10');
    assert.equal(params.get('kinds'), 'feature,decision');
    assert.equal(params.get('scope'), 'docs');
    assert.equal(params.get('currentThreadId'), 'thread_here');
  });

  test('recent: an omitted window is left to the index default and stated as 7d', async () => {
    const result = await find({});
    assert.equal(request(RECENT).params.get('since'), null);
    assert.equal(block(result, 'recent').range.window, '7d (default)');
    assert.match(block(result, 'recent').range.timestamps, /source file mtime/);
  });

  test('recent: items keep anchor, title, kind, source and time order; cross-posts are hinted once', async () => {
    routes[RECENT] = () => ({
      items: [
        {
          anchor: 'thread:t1',
          title: 'Other thread',
          kind: 'thread',
          updatedAt: '2026-11-15T10:00:00Z',
          source: 'threads',
          suggestedAction: { type: 'cross_post', threadId: 't1' },
        },
        {
          anchor: 'thread:t2',
          title: 'Another',
          kind: 'thread',
          updatedAt: '2026-11-14T10:00:00Z',
          source: 'threads',
          suggestedAction: { type: 'cross_post', threadId: 't2' },
        },
        { anchor: 'docs/plans/p.md', title: 'Plan', kind: 'plan', updatedAt: '2026-11-13T10:00:00Z', source: 'docs' },
      ],
      groups: [
        { key: 'project', type: 'collection', label: 'project', count: 2, available: 5 },
        { key: 'world', type: 'collection', label: 'world', count: 1, available: 3 },
      ],
    });
    const result = await find({ scope: 'all', since: '7d' });
    const recent = block(result, 'recent');
    assert.deepEqual(
      recent.items.map((item) => item.anchor),
      ['thread:t1', 'thread:t2', 'docs/plans/p.md'],
    );
    assert.equal(recent.items[2].source, 'docs');
    assert.match(recent.range.order, /not a relevance ranking/);
    assert.deepEqual(recent.range.collections, ['project 2/5', 'world 1/3']);
    assert.equal((text(result).match(/cross_post_message/g) ?? []).length, 1);
  });

  test('recent: scope=trajectories browses task trajectories; with a query it is not a text range', async () => {
    await find({ scope: 'trajectories' });
    assert.equal(request(RECENT).params.get('scope'), 'trajectories');
    requests = [];
    const withQuery = await find({ query: '守望猫', scope: 'trajectories' });
    assert.equal(withQuery.isError, true);
    assert.match(text(withQuery), /trajectories_is_a_browse_scope/);
    assert.deepEqual(requests, []);
  });

  for (const [input, reason] of [
    [{ scope: 'sessions' }, 'scope_unsupported'],
    [{ dateTo: '2026-11-10' }, 'upper_time_bound_unsupported'],
    [{ threadId: 'thread_a' }, 'thread_filter_unsupported'],
    [{ dimension: 'project' }, 'collection_scope_unsupported'],
  ]) {
    test(`recent: browse narrowing ${JSON.stringify(input)} is reported not_covered, never widened`, async () => {
      const result = await find(input);
      assert.equal(request(RECENT), undefined);
      assert.equal(block(result, 'recent').reason, reason);
    });
  }

  test('recent: an index error is a failed group with an error result when nothing else returned a page', async () => {
    routes[RECENT] = () => new Response('bad since', { status: 400 });
    process.env.CAT_CAFE_READONLY = 'true';
    const result = await find({});
    assert.equal(result.isError, true);
    assert.match(block(result, 'recent').error, /recent browse failed \(400\)/);
    assert.equal(parseRecallMetaFromText(text(result)).resultStatus, 'error');
  });

  test('beside a near-full coverage page, every docs row stays and each group is inline or deferred within 24k', async () => {
    const { renderCoverageToolResponse } = await import('../dist/tools/evidence-coverage-response.js');
    const coverage = {
      totalHits: 20,
      bySource: { docs: { count: 20, cap: 20 } },
      matrix: Array.from({ length: 20 }, (_, i) => ({
        title: `Doc ${i} ${'题'.repeat(150)}`,
        anchor: `docs/${'path/'.repeat(85)}source-${i}.md`,
        sourcePath: `docs/${'path/'.repeat(85)}source-${i}.md`,
        kind: 'plan',
        matchType: 'phrase',
        source: 'docs',
      })),
    };
    routes[DOCS] = () => coverage;
    routes[MESSAGES] = () => messagesResponse(Array.from({ length: 5 }, (_, i) => message(i)));
    routes[GRAPH] = () => ({
      status: 'candidates',
      query: '线索',
      candidates: Array.from({ length: 10 }, (_, i) => ({
        anchor: `F${300 + i}`,
        title: `线索 ${'题'.repeat(60)}`,
        kind: 'feature',
        collectionId: 'project',
        sensitivity: 'internal',
        matchReason: 'title',
      })),
    });
    routes[MATTERS] = () => ({
      items: Array.from({ length: 5 }, (_, i) => ({
        matterId: `matter-${i}`,
        title: `线索${'题'.repeat(100)}`,
        description: '',
        revision: 1,
        status: 'active',
        createdAt: 1,
        updatedAt: 2,
        entryCount: 1,
      })),
    });
    const original = text(
      renderCoverageToolResponse(coverage, { query: '线索', limit: 20, intent: 'coverage' }, '"线索"'),
    );
    const result = await find({ query: '线索', intent: 'coverage', limit: 20 });
    const all = text(result);
    assert.ok(all.length <= 24_000, `${all.length}`);
    const anchors = (value) => [...value.matchAll(/^\s+anchor:\s+(\S+)/gm)].map((match) => match[1]);
    assert.deepEqual(anchors(all), anchors(original));
    assert.doesNotMatch(all, /coverage_offset/);
    for (const group of ['messages', 'graph', 'matters']) {
      const rendered = block(result, group);
      assert.ok(['ok', 'deferred'].includes(rendered.status), `${group}: ${rendered.status}`);
      if (rendered.status === 'deferred') {
        assert.equal(rendered.next.arguments.continueGroup, group);
        assert.equal(rendered.next.arguments.query, '线索');
      }
    }
  });

  // ── kinds and limits ──────────────────────────────────────────────────────

  test('kinds with a query: no text group can keep it, so docs and graph report not_covered', async () => {
    const result = await find({ query: '守望猫', kinds: ['feature'] });
    assert.deepEqual(requests, []);
    assert.equal(result.isError, true);
    assert.equal(block(result, 'docs').reason, 'kinds_filter_unsupported');
    assert.equal(block(result, 'graph').reason, 'kinds_filter_unsupported');
  });

  test('a larger shared limit is applied as each group maximum and stated', async () => {
    routes[MESSAGES] = () => messagesResponse([message(1)]);
    const result = await find({ query: '守望猫', limit: 50 });
    assert.equal(request(MESSAGES).params.get('limit'), '20');
    assert.match(block(result, 'messages').limitNote, /messages returns at most 20; limit 50 was applied as 20/);
    requests = [];
    routes[RECENT] = () => ({
      items: [{ anchor: 'docs/a.md', title: 'A', kind: 'plan', updatedAt: '2026-11-15T00:00:00Z', source: 'docs' }],
    });
    const browse = await find({ limit: 150 });
    assert.equal(request(RECENT).params.get('limit'), '100');
    assert.match(block(browse, 'recent').limitNote, /recent returns at most 100; limit 150 was applied as 100/);
  });
});
