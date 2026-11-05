import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { MessageSearchAnswerPublicationService } from '../../dist/domains/memory/MessageSearchAnswerPublicationService.js';
import { MessageSearchAnswerPublicationStore } from '../../dist/domains/memory/MessageSearchAnswerPublicationStore.js';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { MESSAGE_SEARCH_ANSWER_SCHEMA } from '../../dist/domains/memory/message-search-answer-schema.js';

export const producer = { kind: 'invocation', id: 'inv-one', catId: 'codex61-sol' };
export const principal = { userId: 'owner', viewer: { type: 'cat', catId: producer.catId } };
export const human = { userId: 'owner', viewer: { type: 'user' } };
const fact = {
  status: 'decided',
  conclusion: 'piano 的结论',
  featureId: 'F322',
  documentPath: 'docs/features/F322.md',
  documentRevision: 'a'.repeat(40),
  line: 1,
};
export function fixture(path = ':memory:') {
  const db = new Database(path);
  db.exec(MESSAGE_SEARCH_ANSWER_SCHEMA);
  const messages = new MessageStore();
  const source = [0, 1, 2].map((n) =>
    messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'sources',
      content: `piano original source ${n}`,
      mentions: [],
      timestamp: 1000 + n,
    }),
  );
  source.push(
    messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'sources',
      content: 'piano PRIVATE whisper',
      mentions: [],
      timestamp: 1004,
      visibility: 'whisper',
      whisperTo: ['codex61-sol'],
    }),
  );
  const threads = new Map(['origin', 'sources', 'forward'].map((id) => [id, { id, title: id, createdBy: 'owner' }]));
  let searches = 0,
    revision = 'a'.repeat(40),
    calls = 0,
    ledgerActive = true,
    factPatch = {};
  const deps = {
    messageStore: messages,
    threadStore: { get: async (id) => threads.get(id) ?? null, list: async () => [...threads.values()] },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: async () => {
        searches++;
        return {
          passages: source.map((row) => ({
            threadId: row.threadId,
            messageId: row.id,
            docAnchor: 'thread-sources',
            passageId: `msg-${row.id}`,
            content: row.content,
            match: 'lexical',
            createdAt: '2026-10-02',
          })),
          meta: {
            degraded: false,
            effectiveMode: 'lexical',
            sort: 'time',
            candidateLimit: 2000,
            truncated: false,
            semanticCandidatesLimited: false,
            sourceCoverage: 'unknown',
            freshness: 'unknown',
          },
        };
      },
    },
    qualifier: new MessageQueryQualifier(async () => {
      calls++;
      throw new Error('No provider in publication tests');
    }),
    decisionIndex: {
      lookup: async () => ({
        status: 'ready',
        revision,
        facts: ledgerActive
          ? new Map([
              [`sources:${source[0].id}`, [{ ...fact, ...factPatch, documentRevision: revision }]],
              [
                `sources:${source[1].id}`,
                [{ ...fact, ...factPatch, documentRevision: revision, status: 'not-adopted' }],
              ],
            ])
          : new Map(),
      }),
    },
  };
  const search = new MessageSearchService(deps),
    store = new MessageSearchAnswerPublicationStore(db);
  const service = new MessageSearchAnswerPublicationService(store, search, messages, deps.threadStore);
  const request = {
    operationId: 'one-purpose',
    input: { query: 'piano', mode: 'lexical' },
    principal,
    producer,
    targetThreadId: 'origin',
  };
  return {
    db,
    messages,
    source,
    threads,
    threadStore: deps.threadStore,
    search,
    store,
    service,
    request,
    searches: () => searches,
    calls: () => calls,
    setRevision: (value) => {
      revision = value;
    },
    updateDecision: (patch) => {
      factPatch = patch;
    },
    dropLedger: () => {
      ledgerActive = false;
    },
    recreate: () =>
      new MessageSearchAnswerPublicationService(
        new MessageSearchAnswerPublicationStore(db),
        search,
        messages,
        deps.threadStore,
      ),
  };
}
export async function post(f, prepared, overrides = {}) {
  const selection = { publicationRef: prepared.publicationRef, ...overrides.selection };
  const target = overrides.threadId ?? 'origin',
    author = overrides.producer ?? producer;
  const block = await f.service.preparePost(selection, 'owner', author, target);
  assert.ok(block);
  const message = f.messages.append({
    from: { kind: 'agent', catId: author.catId },
    userId: 'owner',
    threadId: target,
    content: 'Answer',
    mentions: [],
    timestamp: 2000,
    origin: 'callback',
    extra: { isExplicitPost: true, rich: { v: 1, blocks: [block] } },
  });
  return { selection, message, published: await f.service.publishPost(selection, message.id, author, 'owner') };
}
export function response(f, status = 'completed', author = producer) {
  return f.messages.append({
    from: { kind: 'agent', catId: author.catId },
    userId: 'owner',
    threadId: 'origin',
    content: 'Answer',
    mentions: [],
    timestamp: 2000,
    origin: 'stream',
    idempotencyKey: `message-lifecycle-response:${author.id}`,
    lifecycle: {
      kind: 'response',
      orderKey: '2000:answer',
      from: { kind: 'agent', catId: author.catId },
      invocationId: author.id,
      targetId: author.catId,
      inputEntryIds: ['entry'],
      inputMessageIds: ['input'],
      status,
      startedAt: 1999,
      ...(status !== 'processing' ? { completedAt: 2000 } : {}),
    },
  });
}
