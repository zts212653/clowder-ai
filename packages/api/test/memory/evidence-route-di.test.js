/**
 * F102 Phase B: Evidence + Reflect Route DI
 * When IEvidenceStore/IReflectionService is provided, bypasses Hindsight entirely.
 */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const MOCK_HINDSIGHT = {
  recall: async () => [],
  retain: async () => {},
  reflect: async () => '',
  ensureBank: async () => {},
  isHealthy: async () => true,
};

describe('evidence route DI (IEvidenceStore path)', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  function createMockEvidenceStore(overrides = {}) {
    return {
      search: async () => [],
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
      ...overrides,
    };
  }

  it('uses IEvidenceStore when provided, skipping Hindsight', async () => {
    let searchQuery;
    const mockStore = createMockEvidenceStore({
      search: async (q) => {
        searchQuery = q;
        return [
          {
            anchor: 'F042',
            kind: 'feature',
            status: 'active',
            title: 'F042: Prompt Audit',
            updatedAt: new Date().toISOString(),
          },
        ];
      },
    });

    let recallCalled = false;
    const mockHindsight = {
      ...MOCK_HINDSIGHT,
      recall: async () => {
        recallCalled = true;
        return [];
      },
    };

    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: mockHindsight,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=prompt+audit',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.ok(body.results.length > 0);
    assert.equal(searchQuery, 'prompt audit');
    assert.equal(recallCalled, false, 'Hindsight recall should NOT be called when IEvidenceStore is provided');
    // P1-2: DI path results must have mapped fields (snippet, confidence, sourceType)
    const r = body.results[0];
    assert.ok('snippet' in r, 'DI evidence result must have snippet');
    assert.ok('confidence' in r, 'DI evidence result must have confidence');
    assert.ok('sourceType' in r, 'DI evidence result must have sourceType');
  });

  it('preserves entity match explanations in search results', async () => {
    const mockStore = createMockEvidenceStore({
      search: async () => [
        {
          anchor: 'thread:vision',
          kind: 'thread',
          status: 'active',
          title: 'Vision discussion',
          summary: 'operator asked about entity anchors',
          updatedAt: new Date().toISOString(),
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
              provenance: [{ source: 'F209 Phase B route contract test' }],
              why: 'query operator matched entity person:landy via alias co-creator',
            },
          ],
        },
      ],
    });
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=operator',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    const match = body.results[0]?.entityMatches?.[0];
    assert.equal(match?.entityId, 'person:landy');
    assert.equal(match?.matchedAlias, 'operator');
    assert.equal(match?.surface, 'co-creator');
    assert.equal(match?.provenance?.[0]?.source, 'F209 Phase B route contract test');
    assert.match(match?.why ?? '', /operator.*person:landy.*co-creator/);
  });

  it('preserves typed drillDown hints in search results', async () => {
    const mockStore = createMockEvidenceStore({
      search: async () => [
        {
          anchor: 'thread:vision',
          kind: 'thread',
          status: 'active',
          title: 'Vision discussion',
          summary: 'operator asked about drill-down readers',
          updatedAt: new Date().toISOString(),
          drillDown: {
            tool: 'cat_cafe_get_thread_context',
            params: { threadId: 'thread_vision', messageId: 'msg-42', before: '3', after: '3' },
            hint: 'get_thread_context(threadId="thread_vision", messageId="msg-42", before=3, after=3)',
          },
        },
      ],
    });
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=drill',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    const drillDown = body.results[0]?.drillDown;
    assert.equal(drillDown?.tool, 'cat_cafe_get_thread_context');
    assert.equal(drillDown?.params?.threadId, 'thread_vision');
    assert.equal(drillDown?.params?.messageId, 'msg-42');
    assert.equal(drillDown?.params?.before, '3');
    assert.equal(drillDown?.params?.after, '3');
    assert.match(drillDown?.hint ?? '', /get_thread_context/);
  });

  it('omits unsafe absolute file-slice drillDown paths from search results', async () => {
    const absolutePath = join(tmpdir(), 'f209-secret-root', 'docs/source.md');
    const mockStore = createMockEvidenceStore({
      search: async () => [
        {
          anchor: 'doc:absolute',
          kind: 'feature',
          status: 'active',
          title: 'Absolute path result',
          summary: 'absolute file-slice path should not leave the API boundary',
          updatedAt: new Date().toISOString(),
          drillDown: {
            tool: 'cat_cafe_read_file_slice',
            params: { path: absolutePath, startLine: '1', endLine: '120' },
            hint: `read_file_slice(path="${absolutePath}", startLine=1, endLine=120)`,
          },
        },
      ],
    });
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=absolute',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results[0]?.drillDown, undefined);
  });

  it('returns 400 for missing q even with IEvidenceStore', async () => {
    const mockStore = createMockEvidenceStore();
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search',
    });

    assert.equal(res.statusCode, 400);
  });

  it('degrades gracefully when IEvidenceStore.search throws', async () => {
    const mockStore = createMockEvidenceStore({
      search: async () => {
        throw new Error('SQLite locked');
      },
    });
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.results.length, 0);
  });

  it('uses IEvidenceStore.searchWithMeta metadata when available', async () => {
    const mockStore = createMockEvidenceStore({
      searchWithMeta: async () => ({
        items: [],
        meta: {
          degraded: true,
          degradeReason: 'passage_embedding_unavailable',
          effectiveMode: 'lexical',
        },
      }),
    });
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=semantic',
    });

    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'passage_embedding_unavailable');
    assert.equal(body.effectiveMode, 'lexical');
  });

  it('surfaces raw non-lexical degradation when KnowledgeResolver omits metadata', async () => {
    const mockStore = createMockEvidenceStore();
    const mockResolver = {
      resolve: async () => ({
        results: [],
        sources: ['project'],
        query: 'test',
      }),
    };
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      evidenceStore: mockStore,
      knowledgeResolver: mockResolver,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=semantic&dimension=library',
    });

    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'raw_lexical_only');
    assert.equal(body.effectiveMode, 'lexical');
  });
});

describe('reflect route DI (IReflectionService path)', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('uses IReflectionService when provided, skipping Hindsight', async () => {
    let reflectQuery;
    const mockReflection = {
      reflect: async (q) => {
        reflectQuery = q;
        return 'Insight from local reflection';
      },
    };

    let hindsightReflectCalled = false;
    const mockHindsight = {
      ...MOCK_HINDSIGHT,
      reflect: async () => {
        hindsightReflectCalled = true;
        return 'from hindsight';
      },
    };

    const { reflectRoutes } = await import('../../dist/routes/reflect.js');
    app = Fastify();
    await app.register(reflectRoutes, {
      hindsightClient: mockHindsight,
      sharedBank: 'cat-cafe-shared',
      reflectionService: mockReflection,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: 'What patterns do we use?' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.reflection, 'Insight from local reflection');
    assert.equal(reflectQuery, 'What patterns do we use?');
    assert.equal(hindsightReflectCalled, false, 'Hindsight reflect should NOT be called');
  });

  it('degrades gracefully when IReflectionService throws', async () => {
    const mockReflection = {
      reflect: async () => {
        throw new Error('LLM timeout');
      },
    };

    const { reflectRoutes } = await import('../../dist/routes/reflect.js');
    app = Fastify();
    await app.register(reflectRoutes, {
      hindsightClient: MOCK_HINDSIGHT,
      sharedBank: 'cat-cafe-shared',
      reflectionService: mockReflection,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: 'test query' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.reflection, '');
  });
});
