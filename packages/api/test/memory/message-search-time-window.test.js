import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';
import {
  compareCanonicalMessages,
  MESSAGE_SEARCH_TIME_WINDOW,
  messageDiscoverySource,
} from '../../dist/domains/memory/message-discovery-source.js';

const collectMessageSearchCandidates = async (input) =>
  (
    await KnowledgeResolver.discover(input.search.query, {
      sources: [messageDiscoverySource({ ...input, read: async () => ({ candidates: input.candidates }) })],
      limit: input.search.sort === 'relevance' ? (input.search.limit ?? 20) + 1 : MESSAGE_SEARCH_TIME_WINDOW,
      check: input.check,
      ...(input.search.sort === 'relevance' ? {} : { compare: compareCanonicalMessages }),
    })
  ).items;

// ROOT accepted K=32 against the isolated coverage/loss study. This guards the
// new contract, not equality with the former age-truncated 2,000-candidate pool.
test('time orders canonical sources within the first 32 admitted relevance rows, retaining semantic-only sources', async () => {
  const candidates = Array.from({ length: 70 }, (_, i) => ({
    threadId: 'visible',
    messageId: `m-${i}`,
    docAnchor: 'thread-visible',
    passageId: `msg-m-${i}`,
    content: i === 31 ? '新伙伴的称呼在这里敲定。' : `Mira 起名 discussion ${i}`,
    match: i === 31 ? 'semantic' : 'lexical',
  }));
  const reads = [];
  const rows = await collectMessageSearchCandidates({
    search: { query: 'Mira 起名', sort: 'time', limit: 1 },
    candidates,
    threadIds: new Set(['visible']),
    check: () => {},
    project: async (candidate) => {
      reads.push(candidate.messageId);
      const i = Number(candidate.messageId.slice(2));
      return {
        ...candidate,
        candidate,
        contentRevision: `version-${i}`,
        result: {
          threadId: candidate.threadId,
          messageId: candidate.messageId,
          timestamp: i === 31 ? 2 : i === 32 ? 1 : 100 + i,
        },
      };
    },
  });
  assert.equal(rows.length, 32, 'the canonical window is bounded even in a long single thread');
  assert.equal(rows[0].messageId, 'm-31', 'in-window semantic source uses canonical time');
  assert.equal(
    rows.some((row) => row.messageId === 'm-32'),
    false,
    'older out-of-window source is honestly omitted',
  );
  assert.equal(reads.length, 32);
});
