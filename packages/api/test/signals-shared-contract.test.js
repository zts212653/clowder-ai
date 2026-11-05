import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const shared = await import('@cat-cafe/shared');

describe('shared signals contract', () => {
  it('exports signal schemas and parses valid source/article payloads', () => {
    assert.ok(shared.SignalSourceSchema, 'SignalSourceSchema export missing');
    assert.ok(shared.SignalArticleSchema, 'SignalArticleSchema export missing');

    const validSource = {
      id: 'openai-news-rss',
      name: 'OpenAI News RSS',
      url: 'https://openai.com/news/rss.xml',
      tier: 1,
      category: 'official',
      enabled: true,
      fetch: {
        method: 'rss',
      },
      schedule: {
        frequency: 'daily',
      },
    };

    const validArticle = {
      id: 'article_abc123',
      url: 'https://openai.com/index/introducing-gpt-6/',
      title: 'Introducing GPT-6',
      source: 'openai-news-rss',
      tier: 1,
      publishedAt: '2026-02-18T08:00:00.000Z',
      fetchedAt: '2026-02-18T08:01:00.000Z',
      status: 'inbox',
      tags: ['release', 'model'],
      filePath: '/home/user/.cat-cafe/signals/library/openai/2026-02-18-gpt6.md',
    };

    const parsedSource = shared.SignalSourceSchema.parse(validSource);
    const parsedArticle = shared.SignalArticleSchema.parse(validArticle);

    assert.equal(parsedSource.fetch.method, 'rss');
    assert.equal(parsedArticle.status, 'inbox');
  });

  it('rejects invalid tier and fetch method', () => {
    assert.ok(shared.SignalSourceSchema, 'SignalSourceSchema export missing');

    const invalidSource = {
      id: 'bad-source',
      name: 'Bad Source',
      url: 'https://example.com/feed',
      tier: 9,
      category: 'official',
      enabled: true,
      fetch: {
        method: 'smtp',
      },
      schedule: {
        frequency: 'daily',
      },
    };

    assert.throws(() => {
      shared.SignalSourceSchema.parse(invalidSource);
    });
  });

  it('keeps filters.maxAgeDays and only accepts positive whole days', () => {
    const source = {
      id: 'openai-news-rss',
      name: 'OpenAI News RSS',
      url: 'https://openai.com/news/rss.xml',
      tier: 1,
      category: 'official',
      enabled: true,
      fetch: { method: 'rss' },
      schedule: { frequency: 'daily' },
    };

    const parsed = shared.SignalSourceSchema.parse({ ...source, filters: { maxAgeDays: 7 } });
    assert.equal(parsed.filters.maxAgeDays, 7);

    for (const maxAgeDays of [0, -3, 1.5]) {
      assert.equal(
        shared.SignalSourceSchema.safeParse({ ...source, filters: { maxAgeDays } }).success,
        false,
        `maxAgeDays=${maxAgeDays} should be rejected`,
      );
    }
  });

  it('rejects unsafe source ids with path traversal characters', () => {
    const invalidIds = ['../outside', '..', '/tmp/evil', 'signals/news', 'news\\archive'];

    for (const id of invalidIds) {
      const invalidSource = {
        id,
        name: 'Bad Source',
        url: 'https://example.com/feed',
        tier: 1,
        category: 'official',
        enabled: true,
        fetch: { method: 'rss' },
        schedule: { frequency: 'daily' },
      };

      assert.throws(() => {
        shared.SignalSourceSchema.parse(invalidSource);
      });
    }
  });
});
