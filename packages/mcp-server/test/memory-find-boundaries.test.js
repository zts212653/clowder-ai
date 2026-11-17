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
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
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
});
