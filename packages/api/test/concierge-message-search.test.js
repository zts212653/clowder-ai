import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractConciergeActions } from '../dist/domains/concierge/concierge-reply-validator.js';
import {
  buildConciergeSearchContext,
  formatConciergeHandleBinding,
} from '../dist/domains/concierge/concierge-search-context.js';

test('concierge uses the common message projection with multiple per-thread handles and honest metadata', async () => {
  let input;
  const results = ['early', 'later'].map((id, index) => ({
    threadId: 'original',
    messageId: id,
    threadTitle: 'Canonical discussion',
    speaker: 'user',
    timestamp: 1000 + index,
    snippet: { text: 'An original source sentence.' },
    publiclyQuotable: true,
  }));
  const response = {
    searchId: 'immutable-search',
    query: 'piano',
    results,
    meta: {
      scope: 'global',
      sort: 'time',
      partial: true,
      freshness: 'unknown',
      sourceCoverage: 'unknown',
      degraded: true,
      effectiveMode: 'lexical',
    },
  };
  const context = await buildConciergeSearchContext({
    userMessage: 'piano',
    threadId: 'concierge-carrier',
    maxResults: 5,
    messageSearch: async (request) => {
      input = request;
      return response;
    },
  });
  assert.deepEqual(input, { query: 'piano', sort: 'time', mode: 'hybrid', limit: 5 });
  assert.deepEqual(
    context.handles.map((h) => h.anchor.messageId),
    ['early', 'later'],
  );
  assert.equal(context.handles[0].anchor.threadId, 'original');
  assert.equal(context.handles[0].anchor.type, 'thread');
  const marker = formatConciergeHandleBinding(context.handles[0].label, context.handles[0].anchor);
  const actions = extractConciergeActions(`[跳过去 ${marker}]`, context.handles);
  assert.equal(actions.length, 1, 'a query handle must reach the existing navigation action consumer');
  assert.equal(actions[0].payload.threadId, 'original');
  assert.equal(actions[0].payload.messageId, 'early');
  assert.match(context.contextString, /全局/);
  assert.match(context.contextString, /延迟暂无法确认/);
  assert.match(context.contextString, /词法/);
  assert.equal(context.messageSearch.searchId, 'immutable-search');
});

test('unavailable message search stays distinguishable from an exhaustive empty answer', async () => {
  const context = await buildConciergeSearchContext({
    userMessage: 'piano',
    threadId: 'concierge-carrier',
    messageSearch: async () => {
      throw new Error('fixture unavailable');
    },
  });
  assert.equal(context.handles.length, 0);
  assert.match(context.contextString, /暂不可用/);
  assert.doesNotMatch(context.contextString, /(?:^|[；。])(?:未找到|没有找到|没有相关消息)/);
});

test('a shared public concierge context does not publish private whisper snippets or handles', async () => {
  const context = await buildConciergeSearchContext({
    userMessage: 'piano',
    threadId: 'concierge-carrier',
    messageSearch: async () => ({
      searchId: 'query',
      query: 'piano',
      results: [
        {
          threadId: 'visible',
          messageId: 'whisper',
          threadTitle: 'Secret title',
          snippet: { text: 'Secret body' },
          publiclyQuotable: false,
        },
      ],
      meta: { scope: 'global', sort: 'time', partial: true, sourceCoverage: 'unknown', freshness: 'unknown' },
    }),
  });
  assert.equal(context.handles.length, 0);
  assert.doesNotMatch(context.contextString, /Secret/);
  assert.deepEqual(context.messageSearch.results, []);
});
