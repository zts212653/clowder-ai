/**
 * F332 find unification (F1): cat_cafe_search_evidence forwards one clue to the docs group and the
 * owner-scoped matters directory group, each with its own status, range and continuation.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseRecallMetaFromText, stripAppendedRecallMetaBlock } from '@cat-cafe/shared';

const docsHit = (i, snippet = 'snippet') => ({
  title: `Doc ${i}`,
  anchor: `docs/plans/doc-${i}.md`,
  snippet,
  matchRank: 'high',
  rank: i + 1,
  relevance: { state: 'phrase' },
  sourceType: 'plan',
});

const matter = (i, extra = {}) => ({
  matterId: `matter-${i}`,
  title: `守望猫 第${i}页`,
  description: '',
  revision: 2,
  status: 'active',
  createdAt: 1_794_000_000_000,
  updatedAt: 1_794_000_000_000 + i,
  entryCount: 3,
  hasThreadSource: false,
  readRef: { kind: 'matter', matterId: `matter-${i}`, expectedRevision: 2 },
  ...extra,
});

const MESSAGES_EMPTY = {
  searchId: 'search-1',
  query: 'q',
  results: [],
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
  },
};
const GRAPH_NO_MATCH = { status: 'no_match', queryKind: 'search', query: 'q', message: 'no node', examples: [] };
const DOCS = '/api/evidence/search';
const GRAPH = '/api/library/graph/resolve';
const MATTERS = '/api/callbacks/memory-matters';
const MESSAGES = '/api/callbacks/search-evidence';
const RECENT = '/api/library/recent';
const sorted = (...list) => [...list].sort();

describe('F332 unified find: docs + matters groups', () => {
  let originalEnv;
  let originalFetch;
  let requests;
  let routes;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('CAT_CAFE_')) delete process.env[key];
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'find-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'find-test-token';
    originalFetch = globalThis.fetch;
    requests = [];
    routes = {
      '/api/evidence/search': () => ({ results: [docsHit(0)], degraded: false }),
      '/api/callbacks/memory-matters': () => ({ items: [matter(1)] }),
      [GRAPH]: () => GRAPH_NO_MATCH,
      [MESSAGES]: () => MESSAGES_EMPTY,
      [RECENT]: () => ({ items: [] }),
    };
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url));
      requests.push({ path: parsed.pathname, params: parsed.searchParams, init });
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

  const load = () => import('../dist/tools/evidence-tools.js');
  const text = (result) => result.content.map((block) => block.text ?? '').join('\n');
  const mattersBlock = (result) =>
    JSON.parse(result.content.find((block) => block.text?.startsWith('{"group":"matters"')).text);
  const paths = () => requests.map((r) => r.path).sort();

  test('a plain query reaches docs, messages, graph and the matter directory with the same whole text', async () => {
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query: '守望猫' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(paths(), sorted(DOCS, GRAPH, MATTERS, MESSAGES));
    const matterRequest = requests.find((r) => r.path === '/api/callbacks/memory-matters');
    assert.equal(matterRequest.params.get('query'), '守望猫');
    assert.equal(matterRequest.params.get('limit'), '5');
    assert.equal(requests.find((r) => r.path === '/api/evidence/search').params.get('q'), '守望猫');

    assert.match(
      result.content[0].text,
      /docs → ok \(1 result\(s\)\) · messages → no_results · graph → no_results · matters → ok \(1\)/,
    );
    const block = mattersBlock(result);
    assert.equal(block.status, 'ok');
    assert.equal(block.query, '守望猫');
    assert.equal(block.complete, true);
    assert.equal(block.items[0].matchedIn, 'title');
    assert.deepEqual(block.items[0].readRef, { kind: 'matter', matterId: 'matter-1', expectedRevision: 2 });
    assert.match(block.match, /literal/);
    // The docs recall sidecar stays the final block so existing telemetry keeps parsing it.
    const meta = parseRecallMetaFromText(text(result));
    assert.equal(meta.resultStatus, 'counted');
    assert.equal(meta.resultCount, 1);
    assert.match(text(result), /anchor: docs\/plans\/doc-0\.md/);
  });

  test('match basis shows where a description matched, without the whole description beside docs', async () => {
    const description = `${'前文'.repeat(80)}守望猫的目录预算${'后文'.repeat(80)}`;
    routes['/api/callbacks/memory-matters'] = () => ({
      items: [matter(1, { title: '目录预算', description })],
      nextCursor: 'cursor-2',
    });
    const { handleSearchEvidence } = await load();
    const block = mattersBlock(await handleSearchEvidence({ query: '守望猫的目录' }));
    const [item] = block.items;
    assert.equal(item.matchedIn, 'description');
    assert.ok(item.matchExcerpt.includes('守望猫的目录'));
    assert.ok(item.matchExcerpt.startsWith('…') && item.matchExcerpt.endsWith('…'));
    assert.equal(item.description, undefined);
    assert.match(block.descriptions, /omitted beside other groups/);
    assert.deepEqual(block.next, {
      tool: 'cat_cafe_search_evidence',
      arguments: { query: '守望猫的目录', matterCursor: 'cursor-2', limit: 5 },
    });
  });

  test('a matters group without a match adds only a short status, never a recent-page fallback', async () => {
    routes['/api/callbacks/memory-matters'] = () => ({ items: [] });
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query: '做视频 翻车 教训' });
    const raw = result.content.find((block) => block.text?.startsWith('{"group":"matters"')).text;
    assert.ok(raw.length < 200, `${raw.length}: ${raw}`);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['complete', 'group', 'match', 'status']);
    assert.match(result.content[0].text, /matters → no_results/);
  });

  test('matterCursor continues only the matters group with the complete returned arguments', async () => {
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query: '守望猫', matterCursor: 'cursor-2', limit: 5 });
    assert.deepEqual(paths(), ['/api/callbacks/memory-matters']);
    const request = requests[0];
    assert.equal(request.params.get('cursor'), 'cursor-2');
    assert.equal(request.params.get('query'), '守望猫');
    assert.equal(request.params.get('limit'), '5');
    assert.match(result.content[0].text, /docs → not run \(continuation\)/);
  });

  test('an omitted query browses the directory with its original page size and whole descriptions', async () => {
    routes['/api/callbacks/memory-matters'] = () => ({ items: [matter(1, { description: '可整段给出的归纳' })] });
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({});
    assert.deepEqual(paths(), sorted(MATTERS, RECENT));
    const directory = requests.find((r) => r.path === MATTERS);
    assert.equal(directory.params.get('query'), null);
    assert.equal(directory.params.get('limit'), '12');
    const block = mattersBlock(result);
    assert.equal(block.items[0].description, '可整段给出的归纳');
    assert.equal(block.items[0].matchedIn, undefined);
    assert.match(result.content[0].text, /docs → not run \(text matching needs a query\)/);
    assert.equal(parseRecallMetaFromText(text(result)).resultCount, 1);
  });

  test('descriptions that do not fit are omitted whole, never cut, and the response stays bounded', async () => {
    const long = '归'.repeat(4_000);
    routes['/api/callbacks/memory-matters'] = () => ({
      items: Array.from({ length: 12 }, (_, i) => matter(i, { description: i < 3 ? '短归纳' : long })),
    });
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({});
    const block = mattersBlock(result);
    assert.equal(block.items[0].description, '短归纳');
    for (const item of block.items.slice(3)) {
      assert.equal(item.description, undefined);
      assert.deepEqual(item.descriptionOmitted, { chars: 4_000 });
    }
    assert.ok(text(result).length <= 24_000);
  });

  test('a long query is not cut for the matter directory: that group reports not_covered', async () => {
    const query = '记'.repeat(201);
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query });
    assert.deepEqual(paths(), sorted(DOCS, GRAPH, MESSAGES));
    assert.equal(requests.find((r) => r.path === DOCS).params.get('q'), query);
    const block = mattersBlock(result);
    assert.equal(block.status, 'not_covered');
    assert.equal(block.reason, 'query_longer_than_200_characters');
    assert.match(result.content[0].text, /matters → not_covered/);
  });

  for (const [field, value, reason] of [
    ['threadId', 'thread_x', 'thread_filter_unsupported'],
    ['dateFrom', '2026-11-01', 'time_filter_unsupported'],
    ['dateTo', '2026-11-10', 'time_filter_unsupported'],
  ]) {
    test(`${field} is a global narrowing the directory cannot keep: not_covered, never a wider list`, async () => {
      const { handleSearchEvidence } = await load();
      const result = await handleSearchEvidence({ query: '守望猫', [field]: value });
      // Docs and messages keep thread and time narrowing; graph and matters report not_covered without a query.
      assert.deepEqual(paths(), sorted(DOCS, MESSAGES));
      assert.equal(requests.find((r) => r.path === DOCS).params.get(field), value);
      assert.equal(requests.find((r) => r.path === MESSAGES).params.get(field), value);
      assert.equal(
        JSON.parse(result.content.find((block) => block.text?.startsWith('{"group":"graph"')).text).status,
        'not_covered',
      );
      const block = mattersBlock(result);
      assert.equal(block.status, 'not_covered');
      assert.equal(block.reason, reason);
    });
  }

  for (const narrowing of [{ scope: 'sessions' }, { resultUnit: 'document' }]) {
    test(`explicit narrowing ${JSON.stringify(narrowing)} keeps the original single-group response`, async () => {
      const { handleSearchEvidence } = await load();
      const result = await handleSearchEvidence({ query: '守望猫', ...narrowing });
      assert.deepEqual(paths(), [DOCS]);
      assert.equal(result.content.length, 1);
      assert.doesNotMatch(text(result), /🔎 Find|"group":/);
    });
  }

  for (const [narrowing, fetched, statuses] of [
    [{ scope: 'docs' }, [DOCS, GRAPH], { graph: 'no_results' }],
    [{ scope: 'threads' }, [DOCS, MESSAGES], { messages: 'no_results' }],
    [{ scope: 'memory' }, [DOCS, MATTERS], { matters: 'ok' }],
    [{ dimension: 'collection', collections: 'world:x' }, [DOCS], { graph: 'not_covered' }],
    [{ dimension: 'global' }, [DOCS], { graph: 'not_covered' }],
    // F2 correction of F1: a library dimension names registered collections; matter pages are not one.
    [{ dimension: 'library' }, [DOCS], { graph: 'not_covered' }],
    [
      { dimension: 'project' },
      [DOCS, MATTERS, MESSAGES],
      { messages: 'no_results', graph: 'not_covered', matters: 'ok' },
    ],
  ]) {
    test(`narrowing ${JSON.stringify(narrowing)} runs the groups inside its range and reports what it cannot keep`, async () => {
      const { handleSearchEvidence } = await load();
      const result = await handleSearchEvidence({ query: '守望猫', ...narrowing });
      assert.deepEqual(paths(), sorted(...fetched));
      const groups = Object.fromEntries(
        result.content
          .filter((block) => block.text?.startsWith('{"group":'))
          .map((block) => JSON.parse(block.text))
          .map((block) => [block.group, block.status]),
      );
      assert.deepEqual(groups, statuses);
    });
  }

  test('explicit resultUnit=message keeps the message search alone', async () => {
    routes['/api/callbacks/search-evidence'] = () => ({ status: 'ok', results: [] });
    const { handleSearchEvidence } = await load();
    await handleSearchEvidence({ query: '守望猫', resultUnit: 'message' });
    assert.deepEqual(paths(), ['/api/callbacks/search-evidence']);
  });

  test('group parameters do not stop the matters group', async () => {
    const { handleSearchEvidence } = await load();
    for (const extra of [
      { mode: 'hybrid' },
      { depth: 'raw', contextWindow: 2 },
      { explain: true },
      { scope: 'all' },
      { graphDepth: 2, graphRelations: ['wikilink'] },
      { messageSort: 'time' },
    ]) {
      requests = [];
      await handleSearchEvidence({ query: '守望猫', ...extra });
      assert.deepEqual(paths(), sorted(DOCS, GRAPH, MATTERS, MESSAGES), JSON.stringify(extra));
    }
  });

  test('an omitted mode keeps each group default; an explicit mode reaches both retrieval groups', async () => {
    const { handleSearchEvidence } = await load();
    await handleSearchEvidence({ query: '守望猫' });
    assert.equal(requests.find((r) => r.path === DOCS).params.get('mode'), null);
    assert.equal(requests.find((r) => r.path === MESSAGES).params.get('mode'), 'hybrid');
    requests = [];
    await handleSearchEvidence({ query: '守望猫', mode: 'lexical' });
    assert.equal(requests.find((r) => r.path === DOCS).params.get('mode'), 'lexical');
    assert.equal(requests.find((r) => r.path === MESSAGES).params.get('mode'), 'lexical');
  });

  for (const [name, setup, fetched, absent] of [
    ['readonly', () => (process.env.CAT_CAFE_READONLY = 'true'), [DOCS, GRAPH], /matters|matter-1|messages/],
    [
      'desktop live companion',
      () => (process.env.CAT_CAFE_DESKTOP_MODE = 'live-companion'),
      [DOCS, GRAPH, MESSAGES],
      /matters|matter-1/,
    ],
    [
      'no callback identity',
      () => delete process.env.CAT_CAFE_INVOCATION_ID && delete process.env.CAT_CAFE_CALLBACK_TOKEN,
      [DOCS, GRAPH],
      /matters|matter-1|messages/,
    ],
  ]) {
    test(`${name}: groups outside this identity's qualification are not queried and leave no trace`, async () => {
      setup();
      const { handleSearchEvidence } = await load();
      const result = await handleSearchEvidence({ query: '守望猫' });
      assert.deepEqual(paths(), sorted(...fetched));
      assert.doesNotMatch(text(result), absent);
    });
  }

  test('readonly without a query browses only the recent index it was qualified for', async () => {
    process.env.CAT_CAFE_READONLY = 'true';
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({});
    assert.deepEqual(paths(), [RECENT]);
    assert.doesNotMatch(text(result), /matters/);
    assert.equal(parseRecallMetaFromText(text(result)).resultStatus, 'no_results');
  });

  test('watcher keeps only its original directory route: docs never run, even with a query', async () => {
    const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
    const { handleSearchEvidence } = await load();
    const result = await withMemoryReadPolicy({ watcher: true, readonly: false }, () =>
      handleSearchEvidence({ query: '守望猫' }),
    );
    assert.deepEqual(paths(), ['/api/callbacks/memory-matters']);
    assert.equal(requests[0].params.get('limit'), '12');
    assert.doesNotMatch(result.content[0].text, /docs/);
    // The directory block stays pure JSON so the watcher's description compaction can parse it.
    assert.equal(mattersBlock(result).items.length, 1);
  });

  test('a failed directory is reported as failed beside successful docs, not as no results', async () => {
    routes['/api/callbacks/memory-matters'] = () =>
      new Response(JSON.stringify({ error: 'invalid_cursor', message: 'Restart from the directory' }), { status: 400 });
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query: '守望猫' });
    assert.equal(result.isError, undefined);
    const block = mattersBlock(result);
    assert.equal(block.status, 'failed');
    assert.match(block.error, /invalid_cursor/);
    assert.match(text(result), /Found 1 result/);
  });

  test('a directory item the projection cannot handle fails only the matters group', async () => {
    routes['/api/callbacks/memory-matters'] = () => ({ items: [{ matterId: 'odd', revision: 1 }] });
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query: '守望猫' });
    assert.equal(result.isError, undefined);
    const block = mattersBlock(result);
    assert.equal(block.status, 'failed');
    assert.match(block.error, /projection failed/);
    assert.match(text(result), /Found 1 result/);
  });

  test('a directory that never answers is bounded by the shared ceiling and never takes docs down', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    routes['/api/callbacks/memory-matters'] = (_params, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const { handleSearchEvidence } = await load();
    const pending = handleSearchEvidence({ query: '守望猫' });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(16_000);
    const result = await pending;
    const block = mattersBlock(result);
    assert.equal(block.status, 'timeout');
    assert.equal(block.cause, 'deadline');
    assert.match(block.detail, /not a no-results claim/);
    assert.match(text(result), /Found 1 result/);
  });

  const uuidMatter = (i, extra = {}) => {
    const matterId = `matter-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    return matter(i, { matterId, readRef: { kind: 'matter', matterId, expectedRevision: 2 }, ...extra });
  };

  test('a legal 30-page directory beside docs is bounded and never fails the docs group', async () => {
    const query = '记'.repeat(200);
    routes['/api/callbacks/memory-matters'] = () => ({
      items: Array.from({ length: 30 }, (_, i) =>
        uuidMatter(i, {
          title: `事项${'题'.repeat(158)}`,
          description: `${'前'.repeat(60)}${query}${'后'.repeat(60)}`,
        }),
      ),
    });
    const { handleSearchEvidence } = await load();
    const combined = await handleSearchEvidence({ query, limit: 30 });
    assert.ok(text(combined).length <= 24_000, `combined ${text(combined).length}`);
    assert.doesNotMatch(text(combined), /docs → failed/);
    assert.match(text(combined), /Found 1 result/);
    assert.equal(mattersBlock(combined).items.length, 30);
    const alone = await handleSearchEvidence({ query, limit: 30, matterCursor: 'cursor-2' });
    assert.ok(text(alone).length <= 24_000, `alone ${text(alone).length}`);
    assert.equal(mattersBlock(alone).items.length, 30);
    assert.equal(alone.isError, undefined);
  });

  const coveragePage = (pathRepeat) => ({
    totalHits: 20,
    bySource: { docs: { count: 20, cap: 20 } },
    matrix: Array.from({ length: 20 }, (_, i) => ({
      title: `Doc ${i} ${'题'.repeat(150)}`,
      anchor: `docs/${'path/'.repeat(pathRepeat)}source-${i}.md`,
      sourcePath: `docs/${'path/'.repeat(pathRepeat)}source-${i}.md`,
      kind: 'plan',
      matchType: 'phrase',
      source: 'docs',
    })),
  });
  const docsBlock = (result) =>
    result.content.find((block) => block.text?.includes('Evidence search results:'))?.text ?? '';
  const joined = (result) => result.content.map((block) => block.text ?? '').join('\n');

  test('a zero-hit matters group leaves a near-full coverage page exactly as docs alone render it', async () => {
    const { renderCoverageToolResponse } = await import('../dist/tools/evidence-coverage-response.js');
    const coverage = coveragePage(85);
    routes['/api/evidence/search'] = () => coverage;
    routes['/api/callbacks/memory-matters'] = () => ({ items: [] });
    const original = text(
      renderCoverageToolResponse(coverage, { query: '线索', limit: 20, intent: 'coverage' }, '"线索"'),
    );
    assert.equal(original.length, 23_729);
    const { handleSearchEvidence } = await load();
    const unified = await handleSearchEvidence({ query: '线索', intent: 'coverage', limit: 20 });
    assert.equal(docsBlock(unified), stripAppendedRecallMetaBlock(original).trimEnd());
    assert.doesNotMatch(joined(unified), /coverage_offset/);
    assert.equal(mattersBlock(unified).status, 'no_results');
    assert.ok(joined(unified).length <= 24_000, `${joined(unified).length}`);
  });

  const anchorsOf = (value) => [...value.matchAll(/^\s+anchor:\s+(\S+)/gm)].map((match) => match[1]);
  /** Decodes the compact coverage rows back into their display values (title, source, sourcePath …). */
  const compactRows = (value) => {
    const header = /^rows: anchor \[matchType\] \[([^\]]*)\]/m.exec(value);
    if (!header) return undefined;
    const fields = header[1].split(', ');
    return [...value.matchAll(/^ {2}anchor: (\S+) \[matchType:([^\]]+)\] (\[.*\])$/gm)].map(
      ([, anchor, matchType, json]) => ({
        anchor,
        matchType,
        ...Object.fromEntries(JSON.parse(json).map((cell, i) => [fields[i], cell])),
      }),
    );
  };
  const paddedPage = (pathRepeat, lastPadding) => {
    const page = coveragePage(pathRepeat);
    const last = page.matrix[19];
    const path = last.anchor.replace('source-19', `${'x'.repeat(lastPadding)}source-19`);
    page.matrix[19] = { ...last, anchor: path, sourcePath: path };
    return page;
  };

  test('reviewer R2 boundary pages: zero-hit, failed and one-hit directories keep every original coverage row', async () => {
    const { renderCoverageToolResponse } = await import('../dist/tools/evidence-coverage-response.js');
    const { handleSearchEvidence } = await load();
    const hit = matter(1, { title: '线索相关事情' });
    for (const [name, padding, route, status] of [
      ['zero_hit_23967', 119, () => ({ items: [] }), 'no_results'],
      ['failed_23967', 119, () => new Response('{}', { status: 503 }), 'failed'],
      ['one_matter_23929', 100, () => ({ items: [hit] }), 'ok'],
    ]) {
      const coverage = paddedPage(85, padding);
      routes['/api/evidence/search'] = () => coverage;
      routes['/api/callbacks/memory-matters'] = route;
      const original = text(
        renderCoverageToolResponse(coverage, { query: '线索', limit: 20, intent: 'coverage' }, '"线索"'),
      );
      const unified = await handleSearchEvidence({ query: '线索', intent: 'coverage', limit: 20 });
      assert.ok(original.length > 23_900, `${name}: ${original.length}`);
      assert.deepEqual(anchorsOf(joined(unified)), anchorsOf(original), name);
      assert.doesNotMatch(joined(unified), /coverage_offset/, name);
      assert.ok(joined(unified).length <= 24_000, `${name}: ${joined(unified).length}`);
      assert.equal(mattersBlock(unified).status, status, name);
      const decoded = compactRows(docsBlock(unified));
      assert.ok(decoded, `${name}: compact rows`);
      assert.deepEqual(
        decoded,
        coverage.matrix.map((item) => ({
          anchor: item.anchor,
          matchType: item.matchType,
          title: item.title,
          source: item.source,
          sourcePath: '=',
        })),
        name,
      );
      assert.equal(parseRecallMetaFromText(joined(unified)).resultCount, 20, name);
    }
    assert.ok(
      mattersBlock(await handleSearchEvidence({ query: '线索', intent: 'coverage', limit: 20 })).items[0].readRef,
    );
  });

  test('across page sizes and matters outcomes, the original coverage rows are always kept, without an extra page', async () => {
    const { renderCoverageToolResponse } = await import('../dist/tools/evidence-coverage-response.js');
    const { handleSearchEvidence } = await load();
    const outcomes = {
      empty: () => ({ items: [] }),
      failed: () => new Response('{}', { status: 503 }),
      one: () => ({ items: [matter(1, { title: '线索相关事情' })] }),
      page: () => ({ items: Array.from({ length: 20 }, (_, i) => matter(i, { title: `线索${'题'.repeat(158)}` })) }),
    };
    let tight = 0;
    for (const [pathRepeat, paddings] of [
      [40, [0]],
      [70, [0]],
      [85, [0, 40, 80, 100, 110, 119, 125, 140]],
      [88, [0, 20, 60]],
      [95, [0]],
    ]) {
      for (const padding of paddings) {
        const coverage = paddedPage(pathRepeat, padding);
        const original = text(
          renderCoverageToolResponse(coverage, { query: '线索', limit: 20, intent: 'coverage' }, '"线索"'),
        );
        if (original.length > 23_800) tight++;
        for (const [name, route] of Object.entries(outcomes)) {
          routes['/api/evidence/search'] = () => coverage;
          routes['/api/callbacks/memory-matters'] = route;
          const unified = await handleSearchEvidence({ query: '线索', intent: 'coverage', limit: 20 });
          const label = `${name} path×${pathRepeat} pad${padding}`;
          assert.ok(joined(unified).length <= 24_000, `${label}: ${joined(unified).length}`);
          assert.ok(mattersBlock(unified), label);
          assert.deepEqual(anchorsOf(joined(unified)), anchorsOf(original), label);
          assert.equal(/coverage_offset/.test(joined(unified)), /coverage_offset/.test(original), label);
        }
      }
    }
    assert.ok(tight >= 4, `boundary pages exercised: ${tight}`);
  });

  test('a docs-only page that fits beside the matters status is byte-identical in the find response', async () => {
    const { renderCoverageToolResponse } = await import('../dist/tools/evidence-coverage-response.js');
    const coverage = coveragePage(70);
    routes['/api/evidence/search'] = () => coverage;
    routes['/api/callbacks/memory-matters'] = () => ({ items: [] });
    const original = text(
      renderCoverageToolResponse(coverage, { query: '线索', limit: 20, intent: 'coverage' }, '"线索"'),
    );
    const { handleSearchEvidence } = await load();
    const unified = await handleSearchEvidence({ query: '线索', intent: 'coverage', limit: 20 });
    assert.equal(docsBlock(unified), stripAppendedRecallMetaBlock(original).trimEnd());
  });

  test('topk beside matters keeps every result and its detail; only the duplicate anchor reminder gives way', async () => {
    const snippet = 's'.repeat(190);
    const results = Array.from({ length: 20 }, (_, i) => ({
      ...docsHit(i, snippet),
      // 40 more characters on one explanation put the docs-only page within the matters status of the cap.
      entityMatches: Array.from({ length: 7 }, (_, j) => ({
        entityId: `entity-${i}-${j}`,
        why: 'w'.repeat(i === 0 && j === 0 ? 120 : 80),
      })),
    }));
    routes['/api/evidence/search'] = () => ({ results, degraded: false });
    routes['/api/callbacks/memory-matters'] = () => ({ items: [] });
    const { handleSearchEvidence } = await load();
    const alone = text(await handleSearchEvidence({ query: '守望猫', limit: 20, resultUnit: 'document' }));
    assert.ok(alone.length > 23_960 && alone.length <= 24_000, `${alone.length}`);
    assert.match(alone, /📌/);
    const unified = await handleSearchEvidence({ query: '守望猫', limit: 20 });
    assert.ok(joined(unified).length <= 24_000);
    assert.doesNotMatch(joined(unified), /bounded topk/);
    assert.doesNotMatch(joined(unified), /📌/);
    assert.equal((joined(unified).match(/entity: entity-/g) ?? []).length, 140);
    assert.deepEqual(anchorsOf(joined(unified)), anchorsOf(alone));
  });

  test('docs keep their original coverage page; a directory page that does not fit is deferred, not squeezed in', async () => {
    const { renderCoverageToolResponse } = await import('../dist/tools/evidence-coverage-response.js');
    const coverage = {
      totalHits: 20,
      bySource: { docs: { count: 20, cap: 20 } },
      matrix: Array.from({ length: 20 }, (_, i) => ({
        title: `Doc ${i} ${'题'.repeat(150)}`,
        anchor: `docs/${'path/'.repeat(70)}source-${i}.md`,
        sourcePath: `docs/${'path/'.repeat(70)}source-${i}.md`,
        kind: 'plan',
        matchType: 'phrase',
        source: 'docs',
      })),
    };
    routes['/api/evidence/search'] = () => coverage;
    routes['/api/callbacks/memory-matters'] = () => ({
      items: Array.from({ length: 20 }, (_, i) => uuidMatter(i, { title: `线索${'题'.repeat(158)}` })),
    });
    const rows = (result) => (text(result).match(/\[matchType:/g) ?? []).length;
    const original = renderCoverageToolResponse(coverage, { query: '线索', limit: 20, intent: 'coverage' }, '"线索"');
    const { handleSearchEvidence } = await load();
    const unified = await handleSearchEvidence({ query: '线索', intent: 'coverage', limit: 20 });
    assert.equal(rows(original), 20);
    assert.equal(rows(unified), 20);
    assert.doesNotMatch(text(unified), /coverage_offset/);
    assert.ok(text(unified).length <= 24_000);
    const block = mattersBlock(unified);
    assert.equal(block.status, 'deferred');
    assert.equal(block.pages, 20);
    assert.deepEqual(block.next, {
      tool: 'cat_cafe_search_evidence',
      arguments: { query: '线索', continueGroup: 'matters', limit: 20 },
    });

    requests = [];
    const opened = await handleSearchEvidence(block.next.arguments);
    assert.deepEqual(paths(), ['/api/callbacks/memory-matters']);
    assert.equal(requests[0].params.get('cursor'), null);
    assert.equal(requests[0].params.get('query'), '线索');
    assert.equal(mattersBlock(opened).items.length, 20);
  });

  test('docs just inside the old budget keep every ranked source reference beside matters', async () => {
    const snippet = 's'.repeat(190);
    routes['/api/evidence/search'] = () => ({
      results: Array.from({ length: 20 }, (_, i) => ({
        ...docsHit(i, snippet),
        // 7 explanations: docs alone render 23,946 characters, inside the original budget.
        entityMatches: Array.from({ length: 7 }, (_, j) => ({ entityId: `entity-${i}-${j}`, why: 'w'.repeat(80) })),
      })),
      degraded: false,
    });
    routes['/api/callbacks/memory-matters'] = () => ({
      items: Array.from({ length: 20 }, (_, i) => matter(i, { title: `守望猫 ${'题'.repeat(150)}` })),
    });
    const { handleSearchEvidence } = await load();
    const result = await handleSearchEvidence({ query: '守望猫', limit: 20 });
    assert.ok(text(result).length <= 24_000, `length ${text(result).length}`);
    for (let i = 0; i < 20; i++) assert.match(text(result), new RegExp(`anchor: docs/plans/doc-${i}\\.md`));
    assert.ok(['ok', 'deferred'].includes(mattersBlock(result).status));
    assert.ok(parseRecallMetaFromText(text(result)));
  });

  for (const [name, route, input] of [
    ['failed', () => new Response(JSON.stringify({ error: 'temporary_directory_failure' }), { status: 503 }), {}],
    ['not_covered', () => ({ items: [] }), { query: '记'.repeat(201) }],
  ]) {
    test(`a ${name} directory as the only group is an error result, never a successful read`, async () => {
      routes['/api/callbacks/memory-matters'] = route;
      const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
      const { handleSearchEvidence } = await load();
      const result = await withMemoryReadPolicy({ watcher: true, readonly: false }, () => handleSearchEvidence(input));
      assert.equal(result.isError, true);
      assert.equal(mattersBlock(result).status, name);
      assert.equal(parseRecallMetaFromText(text(result)).resultStatus, 'error');
    });
  }

  test('limit applies per group up to 100; each group keeps its own maximum and states it', async () => {
    const { handleSearchEvidence, searchEvidenceInputSchema } = await load();
    assert.equal(searchEvidenceInputSchema.limit.safeParse(100).success, true);
    assert.equal(searchEvidenceInputSchema.limit.safeParse(101).success, false);
    const result = await handleSearchEvidence({ query: '守望猫', limit: 30 });
    assert.equal(requests.find((r) => r.path === MATTERS).params.get('limit'), '30');
    assert.equal(requests.find((r) => r.path === DOCS).params.get('limit'), '20');
    assert.equal(requests.find((r) => r.path === MESSAGES).params.get('limit'), '20');
    assert.match(result.content[0].text, /docs returns at most 20; limit 30 was applied as 20/);

    requests = [];
    const docsOnly = await handleSearchEvidence({ query: '守望猫', resultUnit: 'document', limit: 25 });
    assert.equal(requests[0].params.get('limit'), '20');
    assert.match(docsOnly.content[0].text, /docs returns at most 20; limit 25 was applied as 20/);
    assert.ok(parseRecallMetaFromText(text(docsOnly)));

    requests = [];
    await handleSearchEvidence({ limit: 100 });
    assert.equal(requests.find((r) => r.path === RECENT).params.get('limit'), '100');
    assert.equal(requests.find((r) => r.path === MATTERS).params.get('limit'), '30');
  });

  test('the watcher sees the find entry with matters-group fields only; docs fields fail validation', async () => {
    const { createWatcherNativeBridge } = await import('../dist/watcher-native-bridge.js');
    const bridge = await createWatcherNativeBridge({
      credentials: {
        invocationId: 'watch',
        callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN,
        apiUrl: 'http://127.0.0.1:3004',
      },
      allowedToolNames: ['cat_cafe_search_evidence'],
      admit: async () => 'accepted',
    });
    try {
      const [tool] = bridge.tools;
      assert.equal(tool.name, 'cat_cafe_search_evidence');
      assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['limit', 'matterCursor', 'query']);
      assert.ok(JSON.stringify(tool).length < 1_200, 'small schema for the 30k watcher context');
      const rejected = await bridge.call('cat_cafe_search_evidence', { query: '守望猫', scope: 'docs' }, 'call-docs');
      assert.equal(rejected.isError, true);
      requests = [];
      const ok = await bridge.call('cat_cafe_search_evidence', { query: '守望猫' }, 'call-matters');
      assert.equal(ok.isError, undefined);
      assert.deepEqual(paths(), ['/api/callbacks/memory-matters']);
    } finally {
      await bridge.close();
    }
  });

  test('the retired directory name is no longer registered for cats', async () => {
    const { CANONICAL_TOOL_REGISTRY } = await import('../dist/canonical-server-tools.js');
    const names = new Set(CANONICAL_TOOL_REGISTRY.map((tool) => tool.name));
    assert.equal(names.has('cat_cafe_list_memory_matters'), false); // mcp-cutover-negative-reference: absence
    assert.equal(names.has('cat_cafe_search_evidence'), true);
  });
});
