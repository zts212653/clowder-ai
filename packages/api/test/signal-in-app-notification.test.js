import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { SignalInAppNotificationService } = await import('../dist/domains/signals/services/in-app-notification.js');

function createNotificationsConfig(overrides = {}) {
  return {
    version: 1,
    notifications: {
      email: {
        enabled: false,
        provider: 'gmail',
        smtp: {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
        },
        to: 'owner@example.com',
        from: 'Clowder AI Signals <noreply@example.com>',
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
    ...overrides,
  };
}

function createArticle(overrides = {}) {
  return {
    id: 'signal_1',
    url: 'https://example.com/post',
    title: 'Example signal update',
    source: 'openai-news-rss',
    tier: 1,
    publishedAt: '2026-02-19T09:00:00.000Z',
    fetchedAt: '2026-02-19T10:00:00.000Z',
    status: 'inbox',
    tags: [],
    filePath: '/tmp/example.md',
    ...overrides,
  };
}

describe('signal in-app notification service', () => {
  it('returns skipped when in_app notification is disabled', async () => {
    let publishCalls = 0;
    const service = new SignalInAppNotificationService({
      config: createNotificationsConfig({
        notifications: {
          ...createNotificationsConfig().notifications,
          in_app: {
            ...createNotificationsConfig().notifications.in_app,
            enabled: false,
          },
        },
      }),
      sink: {
        async publish() {
          publishCalls += 1;
        },
      },
    });

    const result = await service.publishDailyDigest({
      date: '2026-02-19',
      articles: [createArticle()],
    });

    assert.equal(result.status, 'skipped');
    assert.equal(publishCalls, 0);
  });

  it('publishes digest summary into configured thread', async () => {
    const events = [];
    const service = new SignalInAppNotificationService({
      config: createNotificationsConfig(),
      sink: {
        async publish(event) {
          events.push(event);
        },
      },
    });

    const result = await service.publishDailyDigest({
      date: '2026-02-19',
      articles: [
        createArticle({
          title: 'Claude 5 roadmap',
          source: 'anthropic-news',
          url: 'https://www.anthropic.com/news/claude-5-roadmap',
        }),
      ],
    });

    assert.equal(result.status, 'sent');
    assert.equal(events.length, 1);
    assert.equal(events[0].threadId, 'signals');
    assert.match(events[0].content, /2026-02-19/);
    assert.match(events[0].content, /Claude 5 roadmap/);
  });

  it('returns structured error when sink publish fails', async () => {
    const service = new SignalInAppNotificationService({
      config: createNotificationsConfig(),
      sink: {
        async publish() {
          throw new Error('message store unavailable');
        },
      },
    });

    const result = await service.publishDailyDigest({
      date: '2026-02-19',
      articles: [createArticle()],
    });

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /message store unavailable/);
  });
});
