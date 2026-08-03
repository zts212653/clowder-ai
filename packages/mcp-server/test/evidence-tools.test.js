/**
 * MCP Evidence Tools Tests
 * 测试 cat_cafe_search_evidence 的参数编码与降级提示行为。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Evidence Tools', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    delete process.env.CAT_CAFE_THREAD_ID;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  // Note: `await import()` is cached by ESM — API_URL is evaluated once at module load.
  // Tests share the same CAT_CAFE_API_URL from beforeEach, so this works.
  // If future tests need different URLs, refactor to a factory or re-export a setter.
  test('handleSearchEvidence encodes query and optional params into URL', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    process.env.CAT_CAFE_USER_ID = 'owner-1';

    /** @type {string | URL | undefined} */
    let capturedUrl;
    let capturedInit;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({ results: [], degraded: false }),
      };
    };

    const result = await handleSearchEvidence({
      query: 'hindsight',
      scope: 'docs',
      mode: 'hybrid',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl, 'expected fetch to be called');

    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/evidence/search');
    assert.equal(parsed.searchParams.get('q'), 'hindsight');
    assert.equal(parsed.searchParams.get('scope'), 'docs');
    assert.equal(parsed.searchParams.get('mode'), 'hybrid');
    assert.equal(parsed.searchParams.get('dimension'), 'project');
    assert.equal(capturedInit.headers['x-cat-cafe-user'], 'owner-1');
  });

  test('sends x-cat-cafe-thread-id header from CAT_CAFE_THREAD_ID env (F192 trusted origin channel)', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    process.env.CAT_CAFE_USER_ID = 'owner-1';
    process.env.CAT_CAFE_THREAD_ID = 'thread_eval_memory';

    let capturedInit;
    globalThis.fetch = async (_url, init) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ results: [], degraded: false }) };
    };

    await handleSearchEvidence({ query: 'test' });

    assert.ok(capturedInit, 'expected fetch to be called');
    assert.equal(
      capturedInit.headers['x-cat-cafe-thread-id'],
      'thread_eval_memory',
      'MCP server must send thread ID as trusted header for F192 origin detection',
    );
    assert.equal(capturedInit.headers['x-cat-cafe-user'], 'owner-1');
  });

  test('renders an authoritative empty result for an executed exact thread filter', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [],
        degraded: false,
        filterExecution: {
          requestedThreadId: 'thread_target',
          executedThreadId: 'thread_target',
          outcome: 'authoritative_empty',
        },
      }),
    });

    const result = await handleSearchEvidence({
      query: 'needle',
      scope: 'threads',
      threadId: 'thread_target',
    });
    const text = result.content[0].text;

    assert.match(text, /thread filter executed: thread_target/i);
    assert.match(text, /authoritative empty/i);
  });

  test('handleSearchEvidence forwards current thread and renders suggested cross-post action', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    process.env.CAT_CAFE_THREAD_ID = 'thread-current';

    /** @type {string | URL | undefined} */
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          degraded: false,
          results: [
            {
              title: 'Other thread hit',
              anchor: 'thread:other',
              snippet: 'finding',
              matchRank: 'high',
              sourceType: 'discussion',
              suggestedAction: {
                type: 'cross_post',
                threadId: 'thread-other',
                reason: 'Search result came from another thread; dispatch relevant findings back to that thread.',
                source: 'search_evidence',
              },
            },
          ],
        }),
      };
    };

    const result = await handleSearchEvidence({ query: 'finding', scope: 'threads' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl, 'expected fetch to be called');
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.searchParams.get('currentThreadId'), 'thread-current');
    const text = result.content[0].text;
    assert.ok(text.includes('suggested_action: cat_cafe_cross_post_message(threadId="thread-other"'));
    assert.ok(text.includes('content="@target-cat\\n..."'));
    assert.ok(text.includes('routing: replace @target-cat with the cat handle to wake in the target thread'));
    assert.ok(text.includes('reason: Search result came from another thread'));
  });

  test('handleSearchEvidence preserves explicit dimension overrides', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    /** @type {string | URL | undefined} */
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [], degraded: false }),
      };
    };

    const result = await handleSearchEvidence({
      query: 'cross-collection',
      dimension: 'all',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl, 'expected fetch to be called');

    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.searchParams.get('dimension'), 'all');
  });

  test('handleSearchEvidence renders raw_lexical_only as graceful degradation, not store error', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: true,
        degradeReason: 'raw_lexical_only',
        effectiveMode: 'lexical',
        results: [
          {
            title: 'Decision A',
            anchor: 'docs/decisions/a.md',
            snippet: 'fallback result',
            matchRank: 'low',
            sourceType: 'decision',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'decision' });

    assert.equal(result.isError, undefined);
    assert.ok(
      result.content[0].text.includes('depth=raw currently uses lexical retrieval only'),
      'expected graceful raw degrade message in response text',
    );
    assert.ok(!result.content[0].text.includes('Evidence store error'), 'must not misreport graceful degradation');
  });

  test('HW-4 根因②b: renders sourcePath machine line for path-based consumption match', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'F200 Memory Recall Eval',
            anchor: 'F200',
            snippet: 'eval substrate',
            matchRank: 'high',
            sourceType: 'feature',
            sourcePath: 'docs/features/F200-memory-recall-eval.md',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'F200' });
    const text = result.content[0].text;
    assert.ok(
      text.includes('sourcePath: docs/features/F200-memory-recall-eval.md'),
      'expected stable `sourcePath:` machine line in rendered output (deriveSearchEvidence parses it)',
    );
  });

  test('renders status machine line for temporal result cards', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'S4 Decision A',
            anchor: 'S4-DECISION-A',
            snippet: 'old cache layer',
            matchRank: 'mid',
            sourceType: 'decision',
            status: 'superseded',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'S4-DECISION-A' });
    const text = result.content[0].text;
    assert.ok(text.includes('status: superseded'), 'expected stable `status:` temporal machine line');
  });

  test('renders entity match explanations returned by search_evidence API', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Vision discussion',
            anchor: 'thread:vision',
            snippet: 'operator asked about entity anchors',
            matchRank: 'high',
            sourceType: 'discussion',
            matchReason: 'entity:person:landy',
            entityMatches: [
              {
                entityId: 'person:landy',
                type: 'person',
                canonicalName: 'You',
                matchedAlias: 'operator',
                surface: 'co-creator',
                source: 'passage',
                docAnchor: 'thread:vision',
                passageId: 'p1',
                provenance: [{ source: 'F209 Phase B MCP contract test' }],
                why: 'query operator matched entity person:landy via alias co-creator',
              },
            ],
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'operator', mode: 'hybrid' });
    const text = result.content[0].text;

    assert.ok(text.includes('match: entity:person:landy'), 'should keep coarse entity match reason');
    assert.ok(text.includes('entity: person:landy'), 'should render entity id');
    assert.ok(text.includes('matchedAlias=operator'), 'should render the query alias');
    assert.ok(text.includes('surface=co-creator'), 'should render the matched surface');
    assert.ok(
      text.includes('why: query operator matched entity person:landy via alias co-creator'),
      'should render entity match why explanation',
    );
    assert.ok(text.includes('provenance: F209 Phase B MCP contract test'), 'should render entity match provenance');
  });

  test('renders typed drillDown hints returned by search_evidence API', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Vision discussion',
            anchor: 'thread:vision',
            snippet: 'operator asked about drill-down readers',
            matchRank: 'high',
            sourceType: 'discussion',
            drillDown: {
              tool: 'cat_cafe_get_thread_context',
              params: { threadId: 'thread_vision', messageId: 'msg-42', before: '3', after: '3' },
              hint: 'get_thread_context(threadId="thread_vision", messageId="msg-42", before=3, after=3)',
            },
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'drill-down', mode: 'hybrid' });
    const text = result.content[0].text;

    assert.ok(text.includes('drillDown: cat_cafe_get_thread_context'), 'should render drillDown tool');
    assert.ok(text.includes('threadId=thread_vision'), 'should render threadId param');
    assert.ok(text.includes('messageId=msg-42'), 'should render messageId param');
    assert.ok(text.includes('before=3'), 'should render before window');
    assert.ok(text.includes('after=3'), 'should render after window');
    assert.ok(text.includes('hint: get_thread_context'), 'should render drillDown hint');
  });

  test('Hook F-1: appends Read reminder when high/mid doc anchors present', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'F177 Harness Update',
            anchor: 'F177',
            snippet: 'hotfix governance',
            matchRank: 'high',
            sourceType: 'feature',
          },
          {
            title: 'Session about testing',
            anchor: 'thread:abc123',
            snippet: 'discussed tests',
            matchRank: 'high',
            sourceType: 'thread',
          },
          {
            title: 'ADR-019 Hooks',
            anchor: 'doc:decisions/019',
            snippet: 'hook architecture',
            matchRank: 'mid',
            sourceType: 'decision',
          },
          {
            title: 'Memory System Overview',
            anchor: 'doc:architecture/memory-system-overview',
            snippet: 'architecture map',
            matchRank: 'mid',
            sourceType: 'architecture',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'F177 hooks' });
    const text = result.content[0].text;

    assert.ok(text.includes('Evidence search results:'), 'should include evidence result marker');
    assert.ok(text.includes('Found 4 result(s) for "F177 hooks":'), 'should include query in result header');
    assert.ok(
      text.includes('📌 高匹配文档命中 3 个'),
      'should count only doc-type hits (feature+decision+architecture, not thread)',
    );
    assert.ok(text.includes('F177'), 'should list feature anchor');
    assert.ok(text.includes('doc:decisions/019'), 'should list decision anchor');
    assert.ok(text.includes('doc:architecture/memory-system-overview'), 'should list architecture anchor');
    assert.ok(text.includes('摘要是索引，不是答案'), 'should include Read advice');
  });

  test('Hook F-1: no reminder when only thread/low match-rank results', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Thread discussion',
            anchor: 'thread:xyz',
            snippet: 'some chat',
            matchRank: 'high',
            sourceType: 'thread',
          },
          {
            title: 'Low feature',
            anchor: 'F999',
            snippet: 'barely relevant',
            matchRank: 'low',
            sourceType: 'feature',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'random' });
    const text = result.content[0].text;

    assert.ok(!text.includes('📌 高匹配文档命中'), 'should not show reminder for non-doc or low match-rank results');
  });

  test('Hook F-3: appends invocation search count', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Test',
            anchor: 'test',
            snippet: 'test',
            matchRank: 'low',
            sourceType: 'feature',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'depth test' });
    const text = result.content[0].text;

    assert.ok(text.includes('📊 本轮第'), 'should include invocation search depth counter');
    assert.ok(text.includes('次搜索'), 'should show search count');
  });

  test('Hook F-3: empty results still show depth counter (P2-2 fix)', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [],
      }),
    });

    const result = await handleSearchEvidence({ query: 'nonexistent topic' });
    const text = result.content[0].text;

    assert.ok(
      text.includes('Evidence search results: No results found for: nonexistent topic'),
      'empty results should include evidence result marker',
    );
    assert.ok(text.includes('No results found'), 'should report no results');
    assert.ok(text.includes('📊 本轮第'), 'empty results must still include depth counter');
    assert.ok(text.includes('次搜索'), 'empty results must still show search count');
  });

  test('handleSearchEvidence includes query in error output for frontend correlation', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };

    const result = await handleSearchEvidence({ query: 'quoted "topic"' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.ok(
      text.includes('Evidence search request failed for "quoted \\"topic\\"": connection refused'),
      'should include JSON-quoted query in request error output',
    );
    assert.ok(text.includes('<recall-meta>'), 'error output should include recall result metadata');
    assert.ok(text.includes('"resultStatus":"error"'), 'error output should declare resultStatus:error');
  });

  test('coverage fetch carries an abort signal so an outer client timeout cancels the API request', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    let fetchSignal;
    globalThis.fetch = async (_url, options) => {
      fetchSignal = options?.signal;
      return {
        ok: true,
        json: async () => ({
          totalHits: 0,
          bySource: {
            docs: { count: 0, cap: 0 },
            threads: { count: 0, cap: 0 },
            conventionGraph: { count: 0, cap: 0 },
          },
          matrix: [],
          gaps: [],
        }),
      };
    };

    await handleSearchEvidence({ query: 'bounded', intent: 'coverage' });

    assert.ok(fetchSignal instanceof AbortSignal, 'coverage HTTP fetch must always have a deadline signal');
  });

  test('outer HTTP 408 returns a specific actionable coverage error', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    globalThis.fetch = async () => ({
      ok: false,
      status: 408,
      text: async () => 'Client Timeout',
    });

    const result = await handleSearchEvidence({ query: 'wide', intent: 'coverage', scope: 'docs' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.match(text, /outer HTTP 408/i);
    assert.match(text, /request was cancelled|aborted/i);
    assert.match(text, /narrower scope|retry/i);
  });

  test('intent=coverage formats CoverageSearchResult matrix instead of crashing (P1-2)', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        query: 'production data boundary',
        totalHits: 2,
        bySource: {
          docs: { count: 1, cap: 25 },
          threads: { count: 1, cap: 20 },
          conventionGraph: { count: 0, cap: 10 },
        },
        matrix: [
          {
            anchor: 'docs/iron-rules.md',
            title: 'Redis production Redis (sacred)',
            kind: 'lesson',
            matchType: 'direct',
            retrievalScore: 0.95,
            source: 'docs',
          },
          {
            anchor: 'thread:redis-debug',
            title: 'Redis port 事故',
            kind: 'discussion',
            matchType: 'alias',
            retrievalScore: 0.7,
            source: 'threads',
            expansionProvenance: {
              source: 'frontmatter-alias',
              via: 'keyword:6399',
              edgeStrength: 'heuristic',
            },
          },
        ],
        gaps: [],
      }),
    });

    const result = await handleSearchEvidence({ query: 'production data boundary', intent: 'coverage' });

    assert.equal(result.isError, undefined, 'should not crash on coverage response shape');
    const text = result.content[0].text;
    assert.ok(
      text.includes('Evidence search results: Found 2 result(s) for "production data boundary" [intent=coverage]:'),
      'coverage output should include the standard evidence result marker for live RecallFeed pairing',
    );
    assert.ok(text.includes('2'), 'should show total hits');
    assert.ok(text.includes('Redis production Redis (sacred)'), 'should render matrix item titles');
    assert.ok(text.includes('docs/iron-rules.md'), 'should render anchors');
    assert.ok(text.includes('direct'), 'should show match types');
    assert.ok(text.includes('alias'), 'should show indirect match types');
    assert.ok(text.includes('frontmatter-alias'), 'should show expansion provenance');
    assert.ok(text.includes('retrievalScore: 0.95'), 'should label retrieval score explicitly');
    assert.ok(text.includes('edgeStrength: heuristic'), 'should label expansion edge strength explicitly');
    assert.match(text, /^\[matchType:direct\] Redis production Redis (sacred)$/m);
    const sidecar = JSON.parse(text.match(/<recall-meta>(.+)<\/recall-meta>/)?.[1] ?? '{}');
    assert.equal(sidecar.previewItems?.[0]?.matchType, 'direct');
    assert.equal(sidecar.previewItems?.[0]?.matchRank, undefined);
  });

  test('F263: topk main line renders match, authority, and updated axes without legacy [high]', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Current result',
            anchor: 'F263',
            snippet: 'typed axes',
            matchRank: 'high',
            retrievalScore: 0.88,
            sourceType: 'feature',
            authority: 'validated',
            updatedAt: '2026-07-12T00:00:00Z',
          },
          {
            title: 'Legacy freshness gap',
            anchor: 'legacy-result',
            snippet: 'missing updatedAt',
            matchRank: 'mid',
            sourceType: 'discussion',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'axes' });
    const text = result.content[0].text;
    assert.match(text, /\[match:high · authority:validated · updated:2026-07-12T00:00:00Z\] Current result/);
    assert.match(text, /\[match:mid · authority:unknown · updated:unknown\] Legacy freshness gap/);
    assert.doesNotMatch(text, /\[high\]/);
    assert.match(text, /retrievalScore: 0\.88/);
    const sidecar = JSON.parse(text.match(/<recall-meta>(.+)<\/recall-meta>/)?.[1] ?? '{}');
    assert.equal(sidecar.previewItems?.[0]?.authority, 'validated');
    assert.equal(sidecar.previewItems?.[0]?.updatedAt, '2026-07-12T00:00:00Z');
  });

  test('F263: coverage output renders explicit response truncation and continuation pointer', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        query: 'wide',
        totalHits: 1,
        bySource: {
          docs: { count: 0, cap: 15 },
          threads: { count: 1, cap: 15 },
          conventionGraph: { count: 0, cap: 0 },
        },
        matrix: [{ anchor: 'thread-1', title: 'Thread 1', kind: 'thread', matchType: 'direct', source: 'threads' }],
        gaps: [],
        contract: {
          requested: { scope: 'threads', mode: 'hybrid', limit: 15, offset: 0 },
          executed: { scopes: ['threads'], mode: 'hybrid', limit: 15 },
          latency: { budgetMs: 15000, elapsedMs: 20, timedOut: false },
          response: {
            budgetChars: 24000,
            serializedChars: 12000,
            truncated: true,
            omittedItems: 3,
            drillDown: {
              tool: 'cat_cafe_search_evidence',
              params: { query: 'wide', intent: 'coverage', scope: 'threads', limit: '15', coverage_offset: '1' },
            },
          },
        },
      }),
    });

    const result = await handleSearchEvidence({ query: 'wide', intent: 'coverage', scope: 'threads', limit: 15 });
    const text = result.content[0].text;

    assert.match(text, /response truncated/i);
    assert.ok(text.includes('coverage_offset=1'));
    assert.ok(text.includes('serializedChars: 12000/24000'));
  });

  test('F263: tool description explicitly declares coverage limit and response budget', async () => {
    const { evidenceTools, searchEvidenceInputSchema } = await import('../dist/tools/evidence-tools.js');
    const description = evidenceTools[0].description;

    assert.match(description, /coverage[^.]*limit[^.]*max 20/i);
    assert.match(description, /serialized[^.]*budget/i);
    assert.match(description, /query[^.]*max 2,?000/i);
    assert.match(description, /Use when:/);
    assert.match(description, /NOT for:/);
    assert.match(description, /Output:/);
    assert.match(description, /GOTCHA:/);
    assert.equal(searchEvidenceInputSchema.query.safeParse('q'.repeat(2_000)).success, true);
    assert.equal(searchEvidenceInputSchema.query.safeParse('q'.repeat(2_001)).success, false);
  });

  test('F263: rendered coverage tool output stays within its declared context budget', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    const { COVERAGE_TOOL_RESPONSE_CHAR_BUDGET } = await import('../dist/tools/evidence-coverage-response.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        totalHits: 15,
        bySource: { docs: { count: 0, cap: 0 }, threads: { count: 15, cap: 15 } },
        matrix: Array.from({ length: 15 }, (_, index) => ({
          anchor: `thread-${index}`,
          title: `Thread ${index} ${'x'.repeat(3_000)}`,
          kind: 'thread',
          matchType: 'direct',
          source: 'threads',
        })),
      }),
    });

    const result = await handleSearchEvidence({ query: 'wide', intent: 'coverage', scope: 'threads', limit: 15 });
    const text = result.content[0].text;

    assert.ok(text.length <= COVERAGE_TOOL_RESPONSE_CHAR_BUDGET, `${text.length} exceeds tool output budget`);
    assert.match(text, /response truncated/i);
    assert.match(text, /coverage_offset=\d+/);
  });

  test('F263: final MCP footer is included in the response budget fixed point', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    const { COVERAGE_TOOL_RESPONSE_CHAR_BUDGET } = await import('../dist/tools/evidence-coverage-response.js');
    const query = 'q'.repeat(2_000);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        totalHits: 7,
        bySource: { docs: { count: 7, cap: 15 }, threads: { count: 0, cap: 0 } },
        matrix: Array.from({ length: 7 }, (_, index) => ({
          anchor: `doc-${index}-${'a'.repeat(500)}`,
          title: `Doc ${index} ${'t'.repeat(500)}`,
          kind: 'feature',
          matchType: 'alias',
          source: 'docs',
          expansionProvenance: {
            source: 'frontmatter-alias',
            via: 'p'.repeat(1_525),
            edgeStrength: 'heuristic',
          },
        })),
        contract: {
          latency: { budgetMs: 15000, elapsedMs: 2, timedOut: false },
          response: {
            budgetChars: 24000,
            serializedChars: 22000,
            truncated: true,
            omittedItems: 1,
            hasMore: true,
            drillDown: {
              tool: 'cat_cafe_search_evidence',
              params: { query, intent: 'coverage', scope: 'docs', limit: '15', coverage_offset: '7' },
            },
          },
        },
      }),
    });

    const result = await handleSearchEvidence({ query, intent: 'coverage', scope: 'docs', limit: 15 });
    const text = result.content[0].text;

    assert.ok(text.length <= COVERAGE_TOOL_RESPONSE_CHAR_BUDGET, `${text.length} exceeds final MCP budget`);
    assert.match(text, /response truncated/i);
    assert.match(text, /coverage_offset=6/);
  });

  test('F263: rendered oversize placeholders expose callable or unavailable drill state', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        totalHits: 2,
        bySource: { docs: { count: 2, cap: 15 }, threads: { count: 0, cap: 0 } },
        matrix: [
          {
            anchor: 'oversize:aaaa',
            title: 'Oversize evidence aaaa',
            kind: 'feature',
            matchType: 'direct',
            source: 'docs',
            representation: 'oversize-placeholder',
            identityDigest: 'aaaa',
            drillUnavailable: { code: 'source-reference-unavailable' },
          },
          {
            anchor: 'oversize:bbbb',
            title: 'Oversize evidence bbbb',
            kind: 'feature',
            matchType: 'direct',
            source: 'docs',
            representation: 'oversize-placeholder',
            identityDigest: 'bbbb',
            drillDown: { tool: 'cat_cafe_graph_resolve', params: { anchor: 'F263' }, hint: 'Resolve F263' },
          },
        ],
        contract: {
          latency: { budgetMs: 15000, elapsedMs: 2, timedOut: false },
          response: {
            budgetChars: 24000,
            serializedChars: 1200,
            truncated: true,
            omittedItems: 0,
            oversizeItems: 2,
            hasMore: false,
          },
        },
      }),
    });

    const result = await handleSearchEvidence({ query: 'oversize', intent: 'coverage', scope: 'docs', limit: 15 });
    const text = result.content[0].text;

    assert.match(text, /representation: oversize-placeholder/);
    assert.match(text, /drillUnavailable: source-reference-unavailable/);
    assert.match(text, /drillDown: cat_cafe_graph_resolve/);
  });

  test('search_evidence description warns coverage tasks are not single-query exhaustive', async () => {
    const { evidenceTools } = await import('../dist/tools/evidence-tools.js');
    const description = evidenceTools[0].description;

    assert.ok(description.includes('coverage'), 'description should name coverage/source-map intent');
    assert.ok(description.includes('memory-search-best-practices'), 'description should point to the search skill');
    assert.ok(description.includes('docs + threads'), 'description should recommend multi-scope coverage searches');
    assert.ok(description.includes('architecture'), 'description should name architecture docs as first-class docs');
  });

  // ── F256 Phase B: expansion hints formatting ──────────────────────────

  test('F256 Phase B: renders "📎 Related directions" block when expansionHints present', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Routing System',
            anchor: 'F102-routing',
            snippet: 'core routing',
            matchRank: 'high',
            sourceType: 'feature',
          },
        ],
        expansionHints: [
          {
            anchor: 'F208-capability-profile',
            title: 'Capability Profile Routing',
            kind: 'feature',
            sourcePath: 'features/F208.md',
            provenance: {
              source: 'frontmatter-alias',
              via: 'keyword:routing',
              edgeStrength: 'heuristic',
            },
          },
          {
            anchor: 'thread-abc123-digest',
            title: 'Discussion about routing',
            kind: 'thread',
            provenance: {
              source: 'source-thread',
              via: 'thread-abc123',
              edgeStrength: 'heuristic',
            },
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'routing' });
    const text = result.content[0].text;

    assert.ok(text.includes('📎 Related directions'), 'should render expansion hints header');
    assert.ok(text.includes('F208-capability-profile'), 'should render frontmatter-alias hint anchor');
    assert.ok(text.includes('Capability Profile Routing'), 'should render hint title');
    // AC-B2 (砚砚 P2): provenance shows source type + via
    assert.ok(
      text.includes('[frontmatter-alias: keyword:routing]'),
      'should render provenance source type + via (砚砚 P2 fix)',
    );
    assert.ok(text.includes('thread-abc123-digest'), 'should render source-thread hint anchor');
    assert.ok(text.includes('[source-thread: thread-abc123]'), 'should render source-thread provenance (砚砚 P2 fix)');
  });

  test('F256 Phase B: no "📎 Related directions" block when expansionHints absent', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Some Feature',
            anchor: 'F100',
            snippet: 'basic feature',
            matchRank: 'high',
            sourceType: 'feature',
          },
        ],
        // No expansionHints field
      }),
    });

    const result = await handleSearchEvidence({ query: 'basic' });
    const text = result.content[0].text;

    assert.ok(!text.includes('📎 Related directions'), 'should NOT render expansion block when hints absent');
  });

  test('F256 Phase B: include_expansion=false sends param to API', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    /** @type {string | URL | undefined} */
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [], degraded: false }),
      };
    };

    await handleSearchEvidence({ query: 'test', include_expansion: false });

    assert.ok(capturedUrl, 'expected fetch to be called');
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.searchParams.get('include_expansion'), 'false', 'should pass include_expansion=false to API');
  });

  test('F256 Phase B: include_expansion=true does NOT send param to API (default)', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    /** @type {string | URL | undefined} */
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [], degraded: false }),
      };
    };

    await handleSearchEvidence({ query: 'test', include_expansion: true });

    assert.ok(capturedUrl, 'expected fetch to be called');
    const parsed = new URL(String(capturedUrl));
    assert.equal(
      parsed.searchParams.get('include_expansion'),
      null,
      'should not send include_expansion when true (default)',
    );
  });
});
