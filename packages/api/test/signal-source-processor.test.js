import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { processSources, selectSources } = await import('../dist/domains/signals/services/source-processor.js');
const { DeduplicationService } = await import('../dist/domains/signals/services/deduplication.js');

function createSource(overrides = {}) {
  return {
    id: 'source-rss',
    name: 'Source RSS',
    url: 'https://example.com/rss.xml',
    tier: 1,
    category: 'official',
    enabled: true,
    fetch: {
      method: 'rss',
    },
    schedule: {
      frequency: 'daily',
    },
    ...overrides,
  };
}

function createRawArticle(overrides = {}) {
  return {
    url: 'https://example.com/post',
    title: 'Agent progress',
    publishedAt: '2026-02-19T01:00:00.000Z',
    ...overrides,
  };
}

function createFetchResult(sourceId, articles) {
  return {
    articles,
    errors: [],
    metadata: {
      fetchedAt: '2026-02-19T03:00:00.000Z',
      duration: 10,
      source: sourceId,
    },
  };
}

function createStoredArticle(input) {
  return {
    id: input.articleId,
    url: input.article.url,
    title: input.article.title,
    source: input.source.id,
    tier: input.source.tier,
    publishedAt: input.article.publishedAt,
    fetchedAt: input.fetchedAt,
    status: 'inbox',
    tags: [],
    filePath: `/tmp/${input.articleId}.md`,
    ...(input.article.summary ? { summary: input.article.summary } : {}),
  };
}

describe('signal source processor', () => {
  it('does not leak dedup state when first store attempt for a URL fails', async () => {
    const source = createSource();
    const storeCalls = [];

    const result = await processSources({
      sources: [source],
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch() {
            return createFetchResult(source.id, [
              createRawArticle({
                url: 'https://example.com/retry',
                title: 'First attempt',
              }),
              createRawArticle({
                url: 'https://example.com/retry',
                title: 'Second attempt survives',
              }),
            ]);
          },
        },
      ],
      dryRun: false,
      deduplication: new DeduplicationService(),
      articleStore: {
        async store(input) {
          storeCalls.push(input.article.url);
          if (storeCalls.length === 1) {
            throw new Error('first write fails');
          }
          return createStoredArticle(input);
        },
      },
    });

    assert.deepEqual(storeCalls, ['https://example.com/retry', 'https://example.com/retry']);
    assert.equal(result.fetchedArticles, 2);
    assert.equal(result.duplicateArticles, 0);
    assert.equal(result.storedArticles.length, 1);
    assert.equal(result.storedArticles[0].title, 'Second attempt survives');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'RSS_FETCH_FAILED');
    assert.match(result.errors[0].message, /first write fails/);
  });

  it('continues processing remaining articles when one store write fails', async () => {
    const source = createSource();
    const storeCalls = [];

    const result = await processSources({
      sources: [source],
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch() {
            return createFetchResult(source.id, [
              createRawArticle({
                url: 'https://example.com/a',
                title: 'Article A',
              }),
              createRawArticle({
                url: 'https://example.com/b',
                title: 'Article B',
              }),
            ]);
          },
        },
      ],
      dryRun: false,
      deduplication: {
        checkAndMark(url) {
          return {
            articleId: `signal_${url.endsWith('/a') ? 'a' : 'b'}`,
            isNew: true,
          };
        },
      },
      articleStore: {
        async store(input) {
          storeCalls.push(input.article.url);
          if (input.article.url.endsWith('/a')) {
            throw new Error('disk full');
          }
          return createStoredArticle(input);
        },
      },
    });

    assert.deepEqual(storeCalls, ['https://example.com/a', 'https://example.com/b']);
    assert.equal(result.fetchedArticles, 2);
    assert.equal(result.storedArticles.length, 1);
    assert.equal(result.storedArticles[0].url, 'https://example.com/b');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'RSS_FETCH_FAILED');
    assert.equal(result.errors[0].sourceId, source.id);
    assert.match(result.errors[0].message, /disk full/);
  });

  it('applies include and exclude keyword filters before deduplication and store', async () => {
    const source = createSource({
      filters: {
        keywords: {
          include: ['agent', 'llm'],
          exclude: ['survey only'],
        },
      },
    });

    const dedupCalls = [];
    const storeCalls = [];

    const result = await processSources({
      sources: [source],
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch() {
            return createFetchResult(source.id, [
              createRawArticle({
                url: 'https://example.com/keep',
                title: 'Agent runtime update',
              }),
              createRawArticle({
                url: 'https://example.com/skip-no-include',
                title: 'Browser release notes',
                summary: 'No AI topics here',
              }),
              createRawArticle({
                url: 'https://example.com/skip-exclude',
                title: 'LLM survey only roundup',
              }),
            ]);
          },
        },
      ],
      dryRun: false,
      deduplication: {
        checkAndMark(url) {
          dedupCalls.push(url);
          return {
            articleId: `signal_${dedupCalls.length}`,
            isNew: true,
          };
        },
      },
      articleStore: {
        async store(input) {
          storeCalls.push(input.article.url);
          return createStoredArticle(input);
        },
      },
    });

    assert.deepEqual(dedupCalls, ['https://example.com/keep']);
    assert.deepEqual(storeCalls, ['https://example.com/keep']);
    assert.equal(result.fetchedArticles, 1);
    assert.equal(result.duplicateArticles, 0);
    assert.equal(result.storedArticles.length, 1);
    assert.equal(result.storedArticles[0].url, 'https://example.com/keep');
    assert.equal(result.errors.length, 0);
  });

  it('drops articles older than filters.maxAgeDays against the run clock and keeps undated ones', async () => {
    // A feed that ships its whole archive (e.g. OpenAI News back to 2015) must not
    // flood the inbox on the first scheduled run.
    const source = createSource({ filters: { maxAgeDays: 7 } });
    const storeCalls = [];

    const result = await processSources({
      sources: [source],
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch() {
            return createFetchResult(source.id, [
              createRawArticle({ url: 'https://example.com/fresh', publishedAt: '2026-02-18T00:00:00.000Z' }),
              createRawArticle({ url: 'https://example.com/boundary', publishedAt: '2026-02-12T03:00:00.000Z' }),
              createRawArticle({ url: 'https://example.com/archive', publishedAt: '2015-12-11T00:00:00.000Z' }),
              createRawArticle({ url: 'https://example.com/undated', publishedAt: 'not a date' }),
            ]);
          },
        },
      ],
      dryRun: false,
      deduplication: new DeduplicationService(),
      articleStore: {
        async store(input) {
          storeCalls.push(input.article.url);
          return createStoredArticle(input);
        },
      },
      now: new Date('2026-02-19T03:00:00.000Z'),
    });

    assert.deepEqual(storeCalls, [
      'https://example.com/fresh',
      'https://example.com/boundary',
      'https://example.com/undated',
    ]);
    assert.equal(result.fetchedArticles, 3);
    assert.equal(result.errors.length, 0);
  });

  it('uses local weekday semantics when selecting weekly sources', () => {
    const config = {
      version: 1,
      sources: [
        createSource({ id: 'daily-source', schedule: { frequency: 'daily' } }),
        createSource({ id: 'weekly-source', schedule: { frequency: 'weekly' } }),
        createSource({ id: 'manual-source', schedule: { frequency: 'manual' } }),
      ],
    };

    const localMondayUtcSunday = new Date('2026-02-16T00:30:00.000Z');
    localMondayUtcSunday.getUTCDay = () => 0;
    localMondayUtcSunday.getDay = () => 1;

    const selected = selectSources(config, undefined, localMondayUtcSunday);

    assert.deepEqual(
      selected.map((source) => source.id),
      ['daily-source', 'weekly-source'],
    );
  });
});
