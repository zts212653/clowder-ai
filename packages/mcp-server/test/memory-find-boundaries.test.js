/**
 * F332 find unification (F2 review R1, kimi31-pro): the boundaries of the one find entry.
 * - The narrowing matrix of docs/architecture/memory/find-entry.md, row by row, with and without a query.
 * - Explicit single-search inputs (resultUnit, coverage_offset) never fall into another group.
 * - since keeps the original route's syntax (1–5 digit windows, anchored ISO) and fails as an input error.
 * - Every group's continuation reopens exactly the run it deferred, including the caller's agent-key identity.
 */
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const DOCS = '/api/evidence/search';
const GRAPH = '/api/library/graph/resolve';
const MATTERS = '/api/callbacks/memory-matters';
const MESSAGES = '/api/callbacks/search-evidence';
const RECENT = '/api/library/recent';
const GROUP_PATH = { messages: MESSAGES, graph: GRAPH, matters: MATTERS, recent: RECENT };

const message = (i) => ({
  threadId: 'thread_a',
  messageId: `msg-${i}`,
  threadTitle: `线索讨论 ${'题'.repeat(40)}`,
  speaker: 'codex',
  timestamp: 1_794_000_000_000,
  timelineOrderAt: 1_794_000_000_000,
  snippet: { text: `线索 第${i}条原话`, start: 0, end: 2, source: 'body' },
  highlights: [{ start: 0, end: 2 }],
  match: 'lexical',
  matchEvidence: { kind: 'literal', terms: ['线索'] },
  contentRevision: 'a'.repeat(64),
  publiclyQuotable: true,
});
const messagesResponse = (results) => ({
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
  },
});

describe('F332 unified find: narrowing matrix, explicit inputs, since and continuations', () => {
  let originalEnv;
  let originalFetch;
  let requests;
  let routes;
  let keyFiles;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('CAT_CAFE_')) delete process.env[key];
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'boundaries-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'boundaries-test';
    keyFiles = [];
    originalFetch = globalThis.fetch;
    requests = [];
    routes = {
      [DOCS]: () => ({
        results: [{ title: 'Doc', anchor: 'docs/a.md', snippet: 's', matchRank: 'high', rank: 1, sourceType: 'plan' }],
        degraded: false,
      }),
      [MATTERS]: () => ({ items: [] }),
      [MESSAGES]: () => messagesResponse([]),
      [GRAPH]: () => ({ status: 'no_match', queryKind: 'search', query: 'q', message: 'no node', examples: [] }),
      [RECENT]: () => ({ items: [] }),
    };
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url));
      requests.push({ path: parsed.pathname, params: parsed.searchParams, headers: new Headers(init?.headers ?? {}) });
      const route = routes[parsed.pathname];
      if (!route) throw new Error(`unexpected ${parsed.pathname}`);
      const body = await route(parsed.searchParams, init);
      if (body instanceof Response) return body;
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  });

  /** Answers after `ms`, or rejects when the caller aborts first (like a real slow route). */
  const slow = (ms, body) => (_params, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(body), ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });

  afterEach(() => {
    for (const file of keyFiles) unlinkSync(file);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  /** Shared Antigravity sidecars: one agent key per cat, selected by agentKeyCatId. */
  const useAgentKeyFiles = () => {
    const files = {};
    for (const [catId, secret] of [
      ['antigravity', 'gemini-secret'],
      ['antig-opus', 'claude-secret'],
    ]) {
      const file = join(tmpdir(), `find-agent-key-${catId}-${process.pid}-${Date.now()}.secret`);
      writeFileSync(file, `${secret}\n`, { mode: 0o600 });
      keyFiles.push(file);
      files[catId] = file;
    }
    process.env.CAT_CAFE_AGENT_KEY_FILE = files.antigravity;
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify(files);
  };

  const find = async (input) => (await import('../dist/tools/evidence-tools.js')).handleSearchEvidence(input);
  const text = (result) => result.content.map((block) => block.text ?? '').join('\n');
  const block = (result, group) => {
    const found = result.content.find((entry) => entry.text?.startsWith(`{"group":"${group}"`));
    return found ? JSON.parse(found.text) : undefined;
  };
  const requested = (path) => requests.some((entry) => entry.path === path);

  /** run = its original route was queried; not_covered = stated, never widened; outside = no status, no request. */
  const assertCell = (result, group, expected, label) => {
    const rendered = block(result, group);
    const path = GROUP_PATH[group];
    if (expected === 'run') {
      assert.ok(requested(path), `${label}: ${group} should query its route`);
      assert.notEqual(rendered?.status, 'not_covered', `${label}: ${group}`);
    } else if (expected === 'not_covered') {
      assert.equal(rendered?.status, 'not_covered', `${label}: ${group}`);
      assert.ok(!requested(path), `${label}: ${group} must not query its route`);
    } else {
      assert.equal(rendered, undefined, `${label}: ${group} is outside the range and leaves no status`);
      assert.ok(!requested(path), `${label}: ${group} must not query its route`);
    }
  };

  // ── narrowing matrix (find-entry.md "Narrowing") ─────────────────────────────

  const OTHER_DIMENSIONS = [
    { dimension: 'library' },
    { dimension: 'collection', collections: 'world:x' },
    { dimension: 'global' },
    { dimension: 'all' },
  ];

  const WITH_QUERY = [
    [{ scope: 'all' }, { docs: 'run', messages: 'run', graph: 'run', matters: 'run' }],
    [{ scope: 'docs' }, { docs: 'run', messages: 'outside', graph: 'run', matters: 'outside' }],
    [{ scope: 'threads' }, { docs: 'run', messages: 'run', graph: 'outside', matters: 'outside' }],
    [{ scope: 'memory' }, { docs: 'run', messages: 'outside', graph: 'outside', matters: 'run' }],
    [{ threadId: 'thread_x' }, { docs: 'run', messages: 'run', graph: 'not_covered', matters: 'not_covered' }],
    [{ dateFrom: '2026-11-01' }, { docs: 'run', messages: 'run', graph: 'not_covered', matters: 'not_covered' }],
    [{ since: '7d' }, { docs: 'run', messages: 'run', graph: 'not_covered', matters: 'not_covered' }],
    [{ dateTo: '2026-11-10' }, { docs: 'run', messages: 'run', graph: 'not_covered', matters: 'not_covered' }],
    [{ dimension: 'project' }, { docs: 'run', messages: 'run', graph: 'not_covered', matters: 'run' }],
    ...OTHER_DIMENSIONS.map((narrowing) => [
      narrowing,
      { docs: 'run', messages: 'outside', graph: 'not_covered', matters: 'outside' },
    ]),
  ];

  for (const [narrowing, expected] of WITH_QUERY) {
    test(`with a query, ${JSON.stringify(narrowing)} keeps the contract row`, async () => {
      const result = await find({ query: '守望猫', ...narrowing });
      const label = JSON.stringify(narrowing);
      assert.equal(requested(DOCS), expected.docs === 'run', `${label}: docs`);
      for (const group of ['messages', 'graph', 'matters']) assertCell(result, group, expected[group], label);
    });
  }

  test('with a query, kinds is kept by no text group: docs and graph not_covered, nothing queried', async () => {
    const result = await find({ query: '守望猫', kinds: ['decision'] });
    assert.deepEqual(requests, []);
    assert.equal(block(result, 'docs').status, 'not_covered');
    for (const [group, expected] of Object.entries({ messages: 'outside', graph: 'not_covered', matters: 'outside' }))
      assertCell(result, group, expected, 'kinds');
  });

  const WITHOUT_QUERY = [
    [{}, { recent: 'run', matters: 'run' }],
    [{ scope: 'all' }, { recent: 'run', matters: 'run' }],
    [{ scope: 'docs' }, { recent: 'run', matters: 'outside' }],
    [{ scope: 'threads' }, { recent: 'run', matters: 'outside' }],
    [{ scope: 'memory' }, { recent: 'run', matters: 'run' }],
    [{ scope: 'sessions' }, { recent: 'not_covered', matters: 'outside' }],
    [{ scope: 'trajectories' }, { recent: 'run', matters: 'outside' }],
    [{ threadId: 'thread_x' }, { recent: 'not_covered', matters: 'not_covered' }],
    [{ dateFrom: '2026-11-01' }, { recent: 'run', matters: 'not_covered' }],
    [{ since: '3d' }, { recent: 'run', matters: 'not_covered' }],
    [{ dateTo: '2026-11-10' }, { recent: 'not_covered', matters: 'not_covered' }],
    [{ kinds: ['decision'] }, { recent: 'run', matters: 'outside' }],
    [{ dimension: 'project' }, { recent: 'not_covered', matters: 'run' }],
    ...OTHER_DIMENSIONS.map((narrowing) => [narrowing, { recent: 'not_covered', matters: 'outside' }]),
  ];

  for (const [narrowing, expected] of WITHOUT_QUERY) {
    test(`without a query, ${JSON.stringify(narrowing)} keeps the contract row`, async () => {
      const result = await find(narrowing);
      const label = JSON.stringify(narrowing);
      assert.ok(!requested(DOCS), `${label}: docs needs a query`);
      for (const group of ['recent', 'matters']) assertCell(result, group, expected[group], label);
      for (const group of ['messages', 'graph']) assertCell(result, group, 'outside', label);
    });
  }

  // ── explicit single-search inputs ─────────────────────────────────────────

  for (const [input, reason] of [
    [{ resultUnit: 'document' }, /needs query text/],
    [{ resultUnit: 'message' }, /needs query text/],
    [{ coverage_offset: 1 }, /needs query text/],
    [{ resultUnit: 'document', scope: 'docs', since: '7d' }, /needs query text/],
    [{ continueGroup: 'recent', resultUnit: 'document' }, /cannot reopen another group/],
    [{ matterCursor: 'first', coverage_offset: 1 }, /cannot reopen another group/],
    [{ query: '守望猫', continueGroup: 'messages', resultUnit: 'message' }, /cannot reopen another group/],
    [{ query: '守望猫', kinds: ['decision'], resultUnit: 'document' }, /cannot keep this range \(docs: kinds/],
    [{ query: '守望猫', scope: 'trajectories', coverage_offset: 1 }, /cannot keep this range \(docs: trajectories/],
  ]) {
    test(`explicit single search ${JSON.stringify(input)} is an input error, never another group`, async () => {
      const result = await find(input);
      assert.equal(result.isError, true);
      assert.match(text(result), /resultUnit and coverage_offset select the original document search alone/);
      assert.match(text(result), reason);
      assert.deepEqual(requests, []);
    });
  }

  // ── since syntax (the recent route's own validation) ─────────────────────

  for (const since of ['999999999999999d', '100000d', '2026-11-01junk', '7days', 'tomorrow', '2026-11-1', '24 h']) {
    for (const query of ['守望猫', undefined]) {
      test(`since ${JSON.stringify(since)} ${query ? 'with' : 'without'} a query is a structured input error`, async () => {
        const result = await find({ ...(query ? { query } : {}), since });
        assert.equal(result.isError, true);
        assert.match(text(result), /since must be like 7d, 24h or an ISO 8601 date/);
        assert.deepEqual(requests, []);
      });
    }
  }

  for (const since of ['99999d', '24h', '2026-11-01', '2026-11-01T08:00+14:00', '2026-11-01T08:00:00.000Z']) {
    test(`since ${JSON.stringify(since)} is accepted and resolved to an exact lower bound`, async () => {
      const result = await find({ query: '守望猫', since });
      assert.notEqual(result.isError, true, text(result));
      const lower = requests.find((entry) => entry.path === DOCS).params.get('dateFrom');
      assert.match(lower, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  }

  // ── continuations reopen exactly the deferred run ─────────────────────────

  const normalisedPlan = (plan) => {
    assert.equal(plan.kind, 'run');
    const { limitNote: _note, ...run } = plan.run;
    return run;
  };

  for (const [group, factoryModule, factoryName, input] of [
    [
      'messages',
      'memory-find-messages',
      'createMessagesGroup',
      {
        query: '守望猫',
        threadId: 'thread_a',
        since: '24h',
        dateTo: '2026-11-20',
        mode: 'lexical',
        messageSort: 'time',
        agentKeyCatId: 'antig-opus',
        limit: 7,
      },
    ],
    ['messages', 'memory-find-messages', 'createMessagesGroup', { query: '守望猫', agentKeyCatId: 'antig-opus' }],
    ['graph', 'memory-find-graph', 'createGraphGroup', { query: 'F186', graphDepth: 2, graphRelations: ['wikilink'] }],
    ['matters', 'memory-find-matters', 'createMattersGroup', { query: '守望猫', limit: 9 }],
    ['matters', 'memory-find-matters', 'createMattersGroup', {}],
    [
      'recent',
      'memory-find-recent',
      'createRecentGroup',
      { scope: 'docs', since: '3d', kinds: ['decision'], limit: 30 },
    ],
    ['recent', 'memory-find-recent', 'createRecentGroup', { dateFrom: '2026-11-01', scope: 'trajectories' }],
  ]) {
    test(`${group} continuation from ${JSON.stringify(input)} reopens the same run`, async () => {
      useAgentKeyFiles();
      const { buildFindContext } = await import('../dist/tools/memory-find.js');
      const create = (await import(`../dist/tools/${factoryModule}.js`))[factoryName];
      const original = create(buildFindContext(input));
      const args = original.continueArguments();
      assert.equal(args.continueGroup, group);
      const reopened = buildFindContext(args);
      assert.equal(typeof reopened, 'object', String(reopened));
      assert.equal(reopened.mode, 'continue');
      assert.deepEqual(normalisedPlan(create(reopened).plan), normalisedPlan(original.plan));
    });
  }

  test('a deferred message group continues under the same shared-sidecar agent key', async () => {
    useAgentKeyFiles();
    // A near-full coverage page and message titles too long for even the minimal message page: messages defer.
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
    routes[MESSAGES] = () =>
      messagesResponse(
        Array.from({ length: 20 }, (_, i) => ({ ...message(i), threadTitle: `线索 ${'题'.repeat(600)}` })),
      );
    const first = await find({ query: '线索', intent: 'coverage', limit: 20, agentKeyCatId: 'antig-opus' });
    const deferred = block(first, 'messages');
    assert.equal(deferred.status, 'deferred');
    assert.deepEqual(deferred.next.arguments, {
      query: '线索',
      continueGroup: 'messages',
      limit: 20,
      agentKeyCatId: 'antig-opus',
    });

    // The continuation runs in the shared Antigravity sidecar: only the agent key identifies the cat.
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    requests = [];
    const continued = await find(deferred.next.arguments);
    assert.notEqual(continued.isError, true, text(continued));
    assert.deepEqual(
      requests.map((entry) => entry.path),
      [MESSAGES],
    );
    assert.equal(requests[0].headers.get('x-agent-key-secret'), 'claude-secret');
    assert.equal(block(continued, 'messages').status, 'ok');
  });

  // ── unfinished groups keep a way back (plan: every group gives its complete continuation) ──────

  // Astra 0001794910967669-000742 + plan line 24: the usual find needs no mode choice, and an equal journey may not add
  // calls. Live 2026-11-17: the original message route answered in 3.7–9.2s while the old 3s wait after docs cut it,
  // turning one explicit message search into find + continuation. Groups are no longer cut when docs settle.
  for (const [label, route, group] of [
    ['messages', MESSAGES, 'messages'],
    ['the matter directory', MATTERS, 'matters'],
  ]) {
    test(`a ${label} answer that takes 9s still arrives in the same default find (no extra call)`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const body = route === MESSAGES ? messagesResponse([message(1)]) : { items: [] };
      routes[route] = slow(9_000, body);
      const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
      const pending = handleSearchEvidence({ query: '守望猫' });
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(9_000);
      const result = await pending;
      const answered = block(result, group);
      assert.notEqual(answered.status, 'timeout', JSON.stringify(answered));
      assert.equal(requests.filter((entry) => entry.path === route).length, 1);
    });
  }

  test('a group reopened alone is not cut by the shared ceiling: it waits for its own route like the old tool', async () => {
    // Live 2026-11-17: the message route answered in 9.1s and 11.4s; the reopened group was cut at 10.0s, so the
    // default find could never return messages that the old explicit message search did.
    routes[MESSAGES] = slow(10_500, messagesResponse([message(1)]));
    const reopened = await find({ query: '守望猫', continueGroup: 'messages', limit: 5 });
    assert.deepEqual(
      requests.map((entry) => entry.path),
      [MESSAGES],
    );
    assert.equal(block(reopened, 'messages').status, 'ok');
    assert.equal(block(reopened, 'messages').items.length, 1);
  });

  // codex61-sol #7215 R1: the watcher's own query also moved from 10s to the 16s shared ceiling.
  test('a watcher query gets the 16s shared ceiling: a directory answering at 12s arrives in one call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    routes[MATTERS] = slow(12_000, { items: [] });
    const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    const pending = withMemoryReadPolicy({ watcher: true, readonly: false }, () =>
      handleSearchEvidence({ query: '守望猫' }),
    );
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(12_000);
    assert.equal(block(await pending, 'matters').status, 'no_results');
    assert.equal(requests.filter((entry) => entry.path === MATTERS).length, 1);
  });

  // Plan owner's ruling thread_mwixqbezq81zubdw#0001794918820465-001068-e0cb853b: only a group that really outlasts the
  // shared waiting budget may report timeout with its complete next. The continuation still counts in the journey (the
  // original graph tool: one call; the default find: two) — a boundary of the budget, not evidence of no added calls.
  test('a graph route answering after the 16s budget reports timeout with its continuation (counted as a second call)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    routes[GRAPH] = slow(17_000, {
      status: 'no_match',
      queryKind: 'search',
      query: 'F186',
      message: 'no node',
      examples: [],
    });
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    const pending = handleSearchEvidence({ query: 'F186' });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(16_000);
    const graph = block(await pending, 'graph');
    assert.equal(graph.status, 'timeout');
    assert.equal(graph.cause, 'deadline');
    assert.deepEqual(graph.next.arguments, { query: 'F186', continueGroup: 'graph' });
  });

  // Same ruling, item 3: a caller that already knows only one group is needed may read it alone on its first call, with
  // the same query and that group's parameters. Like the original tool it is not cut by the shared budget.
  test('a first call with continueGroup reads one group alone: a 17s graph route answers in one call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const readRef = { kind: 'file', path: 'docs/features/F186.md', startLine: 1 };
    routes[GRAPH] = slow(17_000, {
      status: 'graph',
      queryKind: 'exact',
      resolvedAnchor: 'F186',
      graph: {
        center: 'F186',
        depth: 1,
        nodes: [
          {
            anchor: 'F186',
            title: 'F186',
            kind: 'feature',
            collectionId: 'project',
            sensitivity: 'internal',
            redacted: false,
            readRef,
          },
        ],
        edges: [],
      },
    });
    const pending = find({ query: 'F186', continueGroup: 'graph', graphDepth: 1 });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(17_000);
    const result = await pending;
    assert.deepEqual(
      requests.map((entry) => entry.path),
      [GRAPH],
    );
    assert.equal(requests[0].params.get('query'), 'F186');
    assert.equal(requests[0].params.get('depth'), '1');
    const graph = block(result, 'graph');
    assert.equal(graph.status, 'ok', JSON.stringify(graph));
    assert.deepEqual(graph.nodes[0].readRef, readRef);
  });

  test('beside another group the 16s shared ceiling still bounds a slow group, and it can be reopened alone', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    routes[RECENT] = slow(16_500, {
      items: [{ anchor: 'docs/a.md', title: 'A', kind: 'plan', updatedAt: '2026-11-17T00:00:00Z', source: 'docs' }],
    });
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    const flush = async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const pending = handleSearchEvidence({ scope: 'all' });
    await flush();
    t.mock.timers.tick(16_000);
    const browse = await pending;
    const recent = block(browse, 'recent');
    assert.equal(recent.status, 'timeout');
    assert.equal(recent.cause, 'deadline');
    assert.match(recent.detail, /16s wait budget/);
    assert.equal(block(browse, 'matters').status, 'no_results');
    const reopenedPending = handleSearchEvidence(recent.next.arguments);
    await flush();
    t.mock.timers.tick(16_500);
    assert.equal(block(await reopenedPending, 'recent').status, 'ok');
  });

  // Watcher (#7205 review note): its directory retry/next page (matterCursor) is also a lone continuation, so it too
  // waits for its route like the pre-F1 list_memory_matters tool did, bounded by the caller's signal.
  // codex61-sol / watcher after #7205: every stop source records its own cause and the first one wins. A caller's
  // cancellation (or the caller's own time limit) is never reported as a shared ceiling the group did not have.
  const findWithSignal = async (input, signal) =>
    (await import('../dist/tools/evidence-tools.js')).handleSearchEvidence(input, { signal });
  const never = (_params, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));

  for (const [label, input, group, route, policy] of [
    ['messages continuation', { query: '守望猫', continueGroup: 'messages', limit: 5 }, 'messages', MESSAGES, null],
    [
      'watcher directory continuation',
      { query: '守望猫', matterCursor: 'first', limit: 12 },
      'matters',
      MATTERS,
      'watcher',
    ],
    ['default find beside docs', { query: '守望猫' }, 'messages', MESSAGES, null],
  ]) {
    test(`a caller cancellation of a ${label} is reported as cancelled, not as a ceiling`, async () => {
      const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
      routes[route] = never;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      const run = () => findWithSignal(input, controller.signal);
      const result = policy ? await withMemoryReadPolicy({ watcher: true, readonly: false }, run) : await run();
      assert.ok(Date.now() - started < 2_000, `${Date.now() - started}ms`);
      const stopped = block(result, group);
      assert.equal(stopped.status, 'timeout');
      assert.equal(stopped.cause, 'cancelled');
      assert.doesNotMatch(stopped.detail, /wait budget|ceiling|shared find deadline/);
      assert.ok(stopped.next.arguments, 'still offers the arguments to retry');
    });
  }

  test('the first stop source wins: a later caller cancellation does not overwrite the shared ceiling', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { GroupRun } = await import('../dist/tools/memory-find-group.js');
    const { buildFindContext } = await import('../dist/tools/memory-find.js');
    const { createMessagesGroup } = await import('../dist/tools/memory-find-messages.js');
    routes[MESSAGES] = never;
    const controller = new AbortController();
    const run = new GroupRun(createMessagesGroup(buildFindContext({ query: '守望猫' })), controller.signal);
    t.mock.timers.tick(16_000);
    controller.abort();
    const render = await run.render({ budgetChars: 10_000, alone: false });
    run.close();
    assert.equal(JSON.parse(render.text).cause, 'deadline');
  });

  test('a watcher directory continuation is a lone continuation and is not cut by the shared ceiling', async () => {
    const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
    routes[MATTERS] = slow(10_500, { items: [] });
    const result = await withMemoryReadPolicy({ watcher: true, readonly: false }, () =>
      find({ query: '守望猫', matterCursor: 'first', limit: 12 }),
    );
    assert.equal(block(result, 'matters').status, 'no_results');
  });

  test('a failed group carries the arguments that retry it alone', async () => {
    routes[GRAPH] = () => new Response('boom', { status: 500 });
    const result = await find({ query: 'F186', graphDepth: 2 });
    const graph = block(result, 'graph');
    assert.equal(graph.status, 'failed');
    assert.deepEqual(graph.next, {
      tool: 'cat_cafe_search_evidence',
      arguments: { query: 'F186', continueGroup: 'graph', graphDepth: 2 },
    });
  });

  test('the smallest form of an unfinished group still carries its continuation', async () => {
    const { groupLadder } = await import('../dist/tools/memory-find-group.js');
    const { buildFindContext } = await import('../dist/tools/memory-find.js');
    const { createMessagesGroup } = await import('../dist/tools/memory-find-messages.js');
    const group = createMessagesGroup(buildFindContext({ query: '守望猫' }));
    for (const outcome of [
      { status: 'timeout', cause: 'cancelled' },
      { status: 'timeout' },
      { status: 'failed', error: 'x' },
    ]) {
      const ladder = groupLadder(group, outcome, { budgetChars: 0, alone: false });
      const smallest = JSON.parse(ladder[ladder.length - 1].text);
      assert.equal(smallest.next.arguments.continueGroup, 'messages', JSON.stringify(outcome));
    }
  });

  // kimi31-pro #7200 R1: a later page that fails or times out must continue from its own cursor, not page 1.
  for (const watcher of [false, true]) {
    test(`a later directory page that fails or times out keeps its own cursor (${watcher ? 'watcher' : 'cats'})`, async () => {
      const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
      const { groupLadder } = await import('../dist/tools/memory-find-group.js');
      const { buildFindContext } = await import('../dist/tools/memory-find.js');
      const { createMattersGroup } = await import('../dist/tools/memory-find-matters.js');
      const policy = { watcher, readonly: false };
      const input = { query: '守望猫', matterCursor: 'cursor-2', limit: 5 };
      const expected = { query: '守望猫', matterCursor: 'cursor-2', limit: 5 };
      routes[MATTERS] = () => new Response('down', { status: 503 });
      const result = await withMemoryReadPolicy(policy, () => find(input));
      assert.equal(requests.find((entry) => entry.path === MATTERS).params.get('cursor'), 'cursor-2');
      const failed = block(result, 'matters');
      assert.equal(failed.status, 'failed');
      assert.deepEqual(failed.next.arguments, expected);
      const group = withMemoryReadPolicy(policy, () => createMattersGroup(buildFindContext(input)));
      for (const outcome of [
        { status: 'timeout', cause: 'deadline' },
        { status: 'failed', error: 'x' },
      ]) {
        const ladder = groupLadder(group, outcome, { budgetChars: 0, alone: true });
        assert.deepEqual(JSON.parse(ladder[ladder.length - 1].text).next.arguments, expected, JSON.stringify(outcome));
      }
    });
  }

  test('the watcher directory continuation stays inside the watcher contract', async () => {
    const { withMemoryReadPolicy } = await import('../dist/tools/memory-read-access.js');
    const { searchEvidenceWatcherContract } = await import('../dist/tools/memory-find-watcher.js');
    routes[MATTERS] = () => new Response('down', { status: 503 });
    const result = await withMemoryReadPolicy({ watcher: true, readonly: false }, () => find({ query: '守望猫' }));
    const matters = block(result, 'matters');
    assert.equal(matters.status, 'failed');
    assert.deepEqual(matters.next.arguments, { query: '守望猫', matterCursor: 'first', limit: 12 });
    assert.equal(searchEvidenceWatcherContract.inputSchema.safeParse(matters.next.arguments).success, true);
  });
});
