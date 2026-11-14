import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { buildSearchableMessageContent } from '../../dist/domains/memory/message-search-content.js';
import { readBeforeSearchCutoff } from '../../dist/domains/memory/message-search-lifetime.js';
import { projectMessageSearchSnippet } from '../../dist/domains/memory/message-search-snippet.js';

const body = `${'前文\n[爪感差: rg+慢]\n'.repeat(4000)}故事 anise`;
const malformedBody = `${'[爪感差: '.repeat(16000)} anise`;
const principal = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };

function fixture(read, sourceBody = body) {
  const thread = { id: 'original', createdBy: 'owner', title: 'Original' };
  const messages = Array.from({ length: 8 }, (_, i) => ({
    id: `original-${i}`,
    threadId: thread.id,
    userId: 'owner',
    catId: null,
    content: sourceBody,
    timestamp: i + 1,
  }));
  let reads = 0;
  const service = new MessageSearchService({
    threadStore: { list: () => [thread], get: () => thread },
    messageStore: {
      getById: async (id) => {
        reads++;
        await read?.();
        return messages.find((m) => m.id === id);
      },
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: async () => ({
        passages: messages.map((m) => ({
          docAnchor: `thread-${thread.id}`,
          passageId: `msg-${m.id}`,
          threadId: thread.id,
          messageId: m.id,
          content: buildSearchableMessageContent(m),
          match: 'lexical',
        })),
        meta: {
          candidateLimit: 2000,
          degraded: false,
          effectiveMode: 'lexical',
          sort: 'relevance',
          truncated: false,
          semanticCandidatesLimited: false,
          sourceCoverage: 'unknown',
          freshness: 'unknown',
        },
      }),
    },
  });
  return { service, reads: () => reads };
}

test('many reports fit a real owned read lifetime without repeated prefix scans', async () => {
  const start = Date.now();
  const value = await readBeforeSearchCutoff(() => projectMessageSearchSnippet(body, 'body', 'anise'), start + 50, {
    deadlineAt: start + 100,
  });
  assert.equal(value.completed, true);
  assert.match(value.value.text, /故事 anise/);
});

test('the actual canonical wave handles eight long multi-report sources within its caller deadline', async () => {
  const { service } = fixture();
  const started = performance.now();
  const response = await service.search({ query: 'anise', mode: 'lexical', sort: 'relevance', limit: 8 }, principal, {
    deadlineAt: Date.now() + 2500,
  });
  assert.equal(response.results.length, 8);
  assert.ok(response.results.every((row) => row.snippet.text === body.slice(row.snippet.start, row.snippet.end)));
  console.log(
    JSON.stringify({
      kind: 'isolated-eight-source-wave',
      characters: body.length,
      elapsedMs: performance.now() - started,
    }),
  );
});

test('external cancellation of a pending long-source wave fails the whole read and ignores late bodies', async () => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { service } = fixture(() => {
    entered();
    return gate;
  });
  const controller = new AbortController();
  const pending = service.search({ query: 'anise', mode: 'lexical', sort: 'relevance', limit: 8 }, principal, {
    signal: controller.signal,
    deadlineAt: Date.now() + 15000,
  });
  await waiting;
  controller.abort(new DOMException('caller canceled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
});

test('unclosed report prefixes fit the same owned lifetime and retain original offsets', async () => {
  const start = Date.now();
  const result = await readBeforeSearchCutoff(
    () => projectMessageSearchSnippet(malformedBody, 'body', 'anise'),
    start + 50,
    {
      deadlineAt: start + 100,
    },
  );
  assert.equal(result.completed, true);
  assert.match(result.value.text, /anise/);
  assert.equal(result.value.text, malformedBody.slice(result.value.start, result.value.end));
});

test('eight malformed sources finish within the actual service caller deadline', async () => {
  const { service } = fixture(undefined, malformedBody);
  const started = performance.now();
  const response = await service.search({ query: 'anise', mode: 'lexical', sort: 'relevance', limit: 8 }, principal, {
    deadlineAt: Date.now() + 2500,
  });
  assert.equal(response.results.length, 8);
  assert.ok(response.results.every((r) => r.snippet.text === malformedBody.slice(r.snippet.start, r.snippet.end)));
  console.log(
    JSON.stringify({
      kind: 'isolated-malformed-wave',
      characters: malformedBody.length,
      elapsedMs: performance.now() - started,
    }),
  );
});

test('malformed source projection does not delay cancellation until the hard deadline', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const current = fixture(() => (current.reads() > 8 ? gate : undefined), malformedBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('caller canceled', 'AbortError')), 50);
  try {
    await assert.rejects(
      current.service.search({ query: 'anise', mode: 'lexical', sort: 'relevance', limit: 8 }, principal, {
        signal: controller.signal,
        deadlineAt: Date.now() + 2500,
      }),
      { name: 'AbortError' },
    );
  } finally {
    clearTimeout(timer);
    release();
    await new Promise((resolve) => setImmediate(resolve));
  }
});
