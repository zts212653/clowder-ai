import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { ArticleStoreService } = await import('../dist/domains/signals/services/article-store.js');
const { createSignalArticleId } = await import('../dist/domains/signals/services/deduplication.js');

function createSource(overrides = {}) {
  return {
    id: 'anthropic-news',
    name: 'Anthropic Newsroom',
    url: 'https://www.anthropic.com/news',
    tier: 1,
    category: 'official',
    enabled: true,
    fetch: {
      method: 'webpage',
      selector: 'article.news-item',
    },
    schedule: {
      frequency: 'daily',
    },
    ...overrides,
  };
}

function createArticle(overrides = {}) {
  return {
    url: 'https://www.anthropic.com/news/claude-5-roadmap',
    title: 'Claude 5 roadmap',
    publishedAt: '2026-02-19T07:00:00.000Z',
    summary: 'Roadmap update',
    content: 'Detailed announcement',
    ...overrides,
  };
}

function createPaths(rootDir) {
  return {
    rootDir,
    configDir: join(rootDir, 'config'),
    libraryDir: join(rootDir, 'library'),
    inboxDir: join(rootDir, 'inbox'),
    logsDir: join(rootDir, 'logs'),
    sourcesFile: join(rootDir, 'config', 'sources.yaml'),
  };
}

class RedisRecorder {
  constructor() {
    this.hsetCalls = [];
    this.zaddCalls = [];
    this.saddCalls = [];
  }

  async hset(...args) {
    this.hsetCalls.push(args);
    return 1;
  }

  async zadd(...args) {
    this.zaddCalls.push(args);
    return 1;
  }

  async sadd(...args) {
    this.saddCalls.push(args);
    return 1;
  }
}

describe('ArticleStoreService', () => {
  it('stores markdown file and updates daily inbox json', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-signals-store-'));
    const paths = createPaths(tempRoot);

    try {
      const service = new ArticleStoreService({ paths });
      const result = await service.store({
        source: createSource(),
        article: createArticle(),
        fetchedAt: '2026-02-19T08:30:00.000Z',
      });

      assert.equal(result.source, 'anthropic-news');
      assert.equal(result.status, 'inbox');
      assert.equal(result.tags.length, 0);
      assert.ok(result.filePath.endsWith('.md'));

      const markdown = readFileSync(result.filePath, 'utf-8');
      assert.match(markdown, /^---\n/);
      assert.match(markdown, /title: "Claude 5 roadmap"/);
      assert.match(markdown, /source: anthropic-news/);
      assert.match(markdown, /# Claude 5 roadmap/);

      const inboxPath = join(paths.inboxDir, '2026-02-19.json');
      const inboxItems = JSON.parse(readFileSync(inboxPath, 'utf-8'));
      assert.equal(inboxItems.length, 1);
      assert.equal(inboxItems[0].id, result.id);
      assert.equal(inboxItems[0].title, 'Claude 5 roadmap');

      await service.store({
        source: createSource(),
        article: createArticle({
          url: 'https://www.anthropic.com/news/claude-5-evals',
          title: 'Claude 5 evals',
        }),
        fetchedAt: '2026-02-19T09:30:00.000Z',
      });

      const updatedInboxItems = JSON.parse(readFileSync(inboxPath, 'utf-8'));
      assert.equal(updatedInboxItems.length, 2);
      assert.equal(updatedInboxItems[1].title, 'Claude 5 evals');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses deterministic id from URL when articleId is not provided', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-signals-store-'));
    const paths = createPaths(tempRoot);

    try {
      const service = new ArticleStoreService({ paths });
      const article = createArticle();
      const result = await service.store({
        source: createSource(),
        article,
        fetchedAt: '2026-02-19T08:30:00.000Z',
      });

      assert.equal(result.id, createSignalArticleId(article.url));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes redis indexes when redis client is provided', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-signals-store-'));
    const paths = createPaths(tempRoot);

    try {
      const redis = new RedisRecorder();
      const service = new ArticleStoreService({ paths, redis });
      const result = await service.store({
        source: createSource(),
        article: createArticle(),
        fetchedAt: '2026-02-19T08:30:00.000Z',
      });

      assert.equal(redis.hsetCalls.length, 1);
      assert.equal(redis.hsetCalls[0][0], `signal:article:${result.id}`);

      assert.equal(redis.zaddCalls.length, 2);
      assert.equal(redis.zaddCalls[0][0], 'signal:inbox');
      assert.equal(redis.zaddCalls[1][0], 'signal:by-source:anthropic-news');

      assert.equal(redis.saddCalls.length, 1);
      assert.equal(redis.saddCalls[0][0], 'signal:by-date:2026-02-19');
      assert.equal(redis.saddCalls[0][1], result.id);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
