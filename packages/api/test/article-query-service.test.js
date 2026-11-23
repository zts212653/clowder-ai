import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { SignalArticleQueryService } = await import('../dist/domains/signals/services/article-query-service.js');

const TEST_PATHS = {
  rootDir: '/tmp/cat-cafe-test-root',
  configDir: '/tmp/cat-cafe-test-root/config',
  libraryDir: '/tmp/cat-cafe-test-root/library',
  inboxDir: '/tmp/cat-cafe-test-root/inbox',
  logsDir: '/tmp/cat-cafe-test-root/logs',
  sourcesFile: '/tmp/cat-cafe-test-root/config/sources.yaml',
};

function createRecord(id, fetchedAt) {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    source: 'anthropic-news',
    tier: 1,
    fetchedAt,
    filePath: `/tmp/${id}.md`,
  };
}

function createParsedDocument(record, status = 'inbox') {
  return {
    article: {
      id: record.id,
      title: record.title,
      url: record.url,
      source: record.source,
      tier: record.tier,
      publishedAt: record.fetchedAt,
      fetchedAt: record.fetchedAt,
      status,
      tags: [],
      filePath: record.filePath,
    },
    content: `content-${record.id}`,
    frontmatter: {},
  };
}

describe('SignalArticleQueryService', () => {
  it('listInbox reads only required article documents for small limits', async () => {
    const records = [
      createRecord('newest', '2026-02-23T12:00:00.000Z'),
      createRecord('middle', '2026-02-22T12:00:00.000Z'),
      createRecord('oldest', '2026-02-21T12:00:00.000Z'),
    ];
    const readCalls = [];

    const service = new SignalArticleQueryService({
      paths: TEST_PATHS,
      deps: {
        readInboxRecords: async () => records,
        readArticleDocument: async (record) => {
          readCalls.push(record.id);
          return createParsedDocument(record);
        },
      },
    });

    const items = await service.listInbox({ limit: 1 });

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'newest');
    assert.deepEqual(readCalls, ['newest']);
  });

  it('listInbox keeps newest probe record when sampled inbox history overflows', async () => {
    const baseTime = Date.parse('2026-02-23T00:00:00.000Z');
    const records = Array.from({ length: 201 }, (_unused, index) =>
      createRecord(`id-${index}`, new Date(baseTime + index * 60_000).toISOString()),
    );
    const readCalls = [];

    const service = new SignalArticleQueryService({
      paths: TEST_PATHS,
      deps: {
        readInboxRecords: async (_paths, _date, options) => {
          if (options && typeof options.maxRecords === 'number') {
            assert.equal(options.maxRecords, 201);
          }
          return records;
        },
        readArticleDocument: async (record) => {
          readCalls.push(record.id);
          return createParsedDocument(record);
        },
      },
    });

    const items = await service.listInbox({ limit: 1 });

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'id-200');
    assert.deepEqual(readCalls, ['id-200']);
  });
  it('getArticleById says whether the full text was fetched (frontmatter enriched)', async () => {
    const records = [
      createRecord('full', '2026-02-23T12:00:00.000Z'),
      createRecord('summary', '2026-02-22T12:00:00.000Z'),
    ];
    const service = new SignalArticleQueryService({
      paths: TEST_PATHS,
      deps: {
        readInboxRecords: async () => records,
        readArticleDocument: async (record) => ({
          ...createParsedDocument(record),
          frontmatter: record.id === 'full' ? { enriched: true } : {},
        }),
      },
    });

    assert.equal((await service.getArticleById('full')).enriched, true);
    assert.equal((await service.getArticleById('summary')).enriched, false);
  });
});
