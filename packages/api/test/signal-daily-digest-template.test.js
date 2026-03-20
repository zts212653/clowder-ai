import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { renderDailyDigestEmail } = await import('../dist/domains/signals/templates/daily-digest.js');

function createArticle(overrides = {}) {
  return {
    id: 'signal_abc123',
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

describe('signal daily digest template', () => {
  it('renders subject and grouped article list', () => {
    const digest = renderDailyDigestEmail({
      date: '2026-02-19',
      articles: [
        createArticle({
          id: 'signal_t2',
          tier: 2,
          source: 'langchain-blog',
          title: 'LangChain async patterns',
          url: 'https://blog.langchain.dev/async-patterns',
          summary: 'Tips for resilient chains',
        }),
        createArticle({
          id: 'signal_t1',
          tier: 1,
          source: 'anthropic-news',
          title: 'Claude 5 roadmap',
          url: 'https://www.anthropic.com/news/claude-5-roadmap',
          summary: 'Roadmap highlights',
        }),
      ],
    });

    assert.equal(digest.subject, '🐱 Clowder AI 信号日报 - 2026-02-19');
    assert.match(digest.html, /Tier 1/);
    assert.match(digest.html, /Tier 2/);
    assert.match(digest.html, /Claude 5 roadmap/);
    assert.match(digest.html, /https:\/\/www\.anthropic\.com\/news\/claude-5-roadmap/);
    assert.match(digest.text, /Roadmap highlights/);
    assert.match(digest.text, /LangChain async patterns/);
  });

  it('renders empty-state digest when there are no articles', () => {
    const digest = renderDailyDigestEmail({
      date: '2026-02-19',
      articles: [],
    });

    assert.equal(digest.subject, '🐱 Clowder AI 信号日报 - 2026-02-19');
    assert.match(digest.html, /今日无新增信号/);
    assert.match(digest.text, /今日无新增信号/);
  });
});
