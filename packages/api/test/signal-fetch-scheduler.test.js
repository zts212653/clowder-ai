import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { runSignalFetchScheduler } = await import('../dist/domains/signals/services/fetch-scheduler.js');

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

function createNotificationsConfig() {
  return {
    version: 1,
    notifications: {
      email: {
        enabled: true,
        provider: 'gmail',
        smtp: {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
        },
        to: 'owner@example.com',
        from: 'Cat Cafe Signals <noreply@example.com>',
      },
      in_app: {
        enabled: true,
        thread: 'signals',
      },
      system: {
        enabled: false,
      },
      schedule: {
        daily_digest: '08:00',
        timezone: 'Asia/Shanghai',
      },
    },
  };
}

describe('runSignalFetchScheduler', () => {
  it('stores only new articles and sends digest notifications in normal mode', async () => {
    const fetchCalls = [];
    const storeCalls = [];
    const emailCalls = [];
    const inAppCalls = [];

    const rssSource = createSource({
      id: 'openai-news-rss',
      url: 'https://openai.com/news/rss.xml',
      fetch: { method: 'rss' },
      schedule: { frequency: 'daily' },
      enabled: true,
    });

    const manualSource = createSource({
      id: 'manual-source',
      fetch: { method: 'rss' },
      schedule: { frequency: 'manual' },
    });

    const disabledSource = createSource({
      id: 'disabled-source',
      enabled: false,
      fetch: { method: 'rss' },
    });

    const summary = await runSignalFetchScheduler({
      loadSources: async () => ({
        version: 1,
        sources: [rssSource, manualSource, disabledSource],
      }),
      loadNotifications: async () => createNotificationsConfig(),
      fetchers: [
        {
          canHandle(source) {
            return source.fetch.method === 'rss';
          },
          async fetch(source) {
            fetchCalls.push(source.id);
            return {
              articles: [
                {
                  url: 'https://openai.com/news/post-1?utm_source=rss',
                  title: 'Duplicate article',
                  publishedAt: '2026-02-19T01:00:00.000Z',
                },
                {
                  url: 'https://openai.com/news/post-2',
                  title: 'Fresh article',
                  publishedAt: '2026-02-19T02:00:00.000Z',
                  summary: 'Fresh summary',
                },
              ],
              errors: [],
              metadata: {
                fetchedAt: '2026-02-19T03:00:00.000Z',
                duration: 12,
                source: source.id,
              },
            };
          },
        },
      ],
      loadKnownUrls: async () => ['https://openai.com/news/post-1'],
      articleStore: {
        async store(input) {
          storeCalls.push(input);
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
        },
      },
      createEmailService: () => ({
        async sendDailyDigest(message) {
          emailCalls.push(message);
          return {
            status: 'sent',
            messageId: 'msg_1',
          };
        },
      }),
      createInAppService: () => ({
        async publishDailyDigest(input) {
          inAppCalls.push(input);
          return {
            status: 'sent',
          };
        },
      }),
      now: () => new Date('2026-02-19T08:00:00.000Z'),
    });

    assert.deepEqual(fetchCalls, ['openai-news-rss']);
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].article.title, 'Fresh article');

    assert.equal(summary.dryRun, false);
    assert.equal(summary.processedSources, 1);
    assert.equal(summary.skippedSources, 2);
    assert.equal(summary.fetchedArticles, 2);
    assert.equal(summary.newArticles, 1);
    assert.equal(summary.storedArticles, 1);
    assert.equal(summary.duplicateArticles, 1);
    assert.equal(summary.errors.length, 0);

    assert.equal(emailCalls.length, 1);
    assert.match(emailCalls[0].subject, /2026-02-19/);
    assert.equal(inAppCalls.length, 1);
    assert.equal(inAppCalls[0].articles.length, 1);
    assert.equal(summary.notifications?.email.status, 'sent');
    assert.equal(summary.notifications?.inApp.status, 'sent');
  });

  it('supports dry-run mode without store writes and notifications', async () => {
    let storeCalled = false;
    let emailCalled = false;
    let inAppCalled = false;

    const summary = await runSignalFetchScheduler({
      dryRun: true,
      loadSources: async () => ({
        version: 1,
        sources: [createSource()],
      }),
      loadNotifications: async () => createNotificationsConfig(),
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch(source) {
            return {
              articles: [
                {
                  url: `${source.url}/a`,
                  title: 'Dry run only',
                  publishedAt: '2026-02-19T01:00:00.000Z',
                },
              ],
              errors: [],
              metadata: {
                fetchedAt: '2026-02-19T03:00:00.000Z',
                duration: 8,
                source: source.id,
              },
            };
          },
        },
      ],
      articleStore: {
        async store() {
          storeCalled = true;
          throw new Error('should not be called');
        },
      },
      createEmailService: () => ({
        async sendDailyDigest() {
          emailCalled = true;
          return { status: 'sent' };
        },
      }),
      createInAppService: () => ({
        async publishDailyDigest() {
          inAppCalled = true;
          return { status: 'sent' };
        },
      }),
      now: () => new Date('2026-02-19T08:00:00.000Z'),
    });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.newArticles, 1);
    assert.equal(summary.storedArticles, 0);
    assert.equal(storeCalled, false);
    assert.equal(emailCalled, false);
    assert.equal(inAppCalled, false);
    assert.equal(summary.notifications, undefined);
  });

  it('skips digest notifications when source fetch contains errors', async () => {
    let emailCalled = false;
    let inAppCalled = false;

    const summary = await runSignalFetchScheduler({
      loadSources: async () => ({
        version: 1,
        sources: [createSource()],
      }),
      loadNotifications: async () => createNotificationsConfig(),
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch(source) {
            return {
              articles: [],
              errors: [
                {
                  code: 'RSS_FETCH_FAILED',
                  sourceId: source.id,
                  message: 'timeout',
                },
              ],
              metadata: {
                fetchedAt: '2026-02-19T03:00:00.000Z',
                duration: 8,
                source: source.id,
              },
            };
          },
        },
      ],
      createEmailService: () => ({
        async sendDailyDigest() {
          emailCalled = true;
          return { status: 'sent' };
        },
      }),
      createInAppService: () => ({
        async publishDailyDigest() {
          inAppCalled = true;
          return { status: 'sent' };
        },
      }),
      now: () => new Date('2026-02-19T08:00:00.000Z'),
    });

    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].sourceId, 'source-rss');
    assert.equal(summary.notifications, undefined);
    assert.equal(emailCalled, false);
    assert.equal(inAppCalled, false);
  });

  it('throws when source filter does not exist', async () => {
    await assert.rejects(
      () =>
        runSignalFetchScheduler({
          sourceId: 'missing-source',
          loadSources: async () => ({
            version: 1,
            sources: [createSource()],
          }),
        }),
      /source "missing-source" not found/,
    );
  });

  it('respects source schedule frequency for automatic source selection', async () => {
    const fetchCalls = [];

    const summary = await runSignalFetchScheduler({
      loadSources: async () => ({
        version: 1,
        sources: [
          createSource({ id: 'daily-source', schedule: { frequency: 'daily' } }),
          createSource({ id: 'hourly-source', schedule: { frequency: 'hourly' } }),
          createSource({ id: 'weekly-source', schedule: { frequency: 'weekly' } }),
          createSource({ id: 'manual-source', schedule: { frequency: 'manual' } }),
        ],
      }),
      loadNotifications: async () => createNotificationsConfig(),
      createEmailService: () => ({
        async sendDailyDigest() {
          return { status: 'sent' };
        },
      }),
      createInAppService: () => ({
        async publishDailyDigest() {
          return { status: 'sent' };
        },
      }),
      fetchers: [
        {
          canHandle() {
            return true;
          },
          async fetch(source) {
            fetchCalls.push(source.id);
            return {
              articles: [],
              errors: [],
              metadata: {
                fetchedAt: '2026-02-17T03:00:00.000Z',
                duration: 5,
                source: source.id,
              },
            };
          },
        },
      ],
      now: () => new Date('2026-02-17T08:00:00.000Z'),
    });

    assert.deepEqual(fetchCalls, ['daily-source', 'hourly-source']);
    assert.equal(summary.processedSources, 2);
    assert.equal(summary.skippedSources, 2);
  });
});
