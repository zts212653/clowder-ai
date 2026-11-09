import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Fastify from 'fastify';
import { prepareAbstractiveBatch, toAbstractiveMessages } from '../../src/domains/memory/abstractive-summary-input.js';
import { parseNaturalLanguageOutput } from '../../src/domains/memory/abstractive-summary-output.js';
import { IndexBuilder } from '../../src/domains/memory/IndexBuilder.js';
import { MessageSearchService } from '../../src/domains/memory/MessageSearchService.js';
import { buildSearchableMessageContent } from '../../src/domains/memory/message-search-content.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import { evidenceRoutes } from '../../src/routes/evidence.js';

const quote = JSON.parse(readFileSync(new URL('./fixtures/f321-quote-comment.json', import.meta.url), 'utf8'));
const makeMessage = (id: string, content: string) => ({ id, content, timestamp: 1000 });
const input = (messages = [makeMessage('m1', 'hello')]) => ({ threadId: 'fixture', previousSummary: null, messages });

test('empty body retains the real quote and owner comment with distinct authors', async () => {
  const messages = await toAbstractiveMessages([quote], {
    getById: () => ({ ...quote, id: quote.contentBlocks[0].attachment.source.messageId, catId: 'opus55' }),
  });
  const prepared = prepareAbstractiveBatch({ ...input(), messages });
  assert.ok(prepared);
  const prompt = prepared.prompts[0];
  assert.ok(prompt.includes(quote.contentBlocks[0].attachment.text));
  assert.ok(prompt.includes(quote.contentBlocks[0].attachment.comment));
  assert.match(prompt, /opus55/);
  assert.match(prompt, /comment author.*user/i);
  assert.ok(prompt.includes(quote.id));
});

test('the real long source includes all 1547 characters and its final line', () => {
  const message = JSON.parse(readFileSync(new URL('./fixtures/f321-long-message.json', import.meta.url), 'utf8'));
  const prepared = prepareAbstractiveBatch({ ...input(), threadId: message.threadId, messages: [message] });
  assert.ok(prepared);
  assert.ok(message.content.length > 1000);
  assert.ok(prepared.prompts[0].includes(message.content));
  assert.ok(prepared.prompts[0].includes(message.content.slice(-100)));
});

test('a message beyond 1000 characters includes its complete tail', () => {
  const content = `${'长'.repeat(3000)}TAIL-MUST-BE-READ`;
  const prepared = prepareAbstractiveBatch(input([makeMessage('long', content)]));
  assert.ok(prepared);
  assert.ok(prepared.prompts.join('').includes(content));
  assert.equal(prepared.input.messages.at(-1)?.id, 'long');
});

test('a bounded batch includes only a complete prefix; later messages remain pending', () => {
  const prepared = prepareAbstractiveBatch(
    input([makeMessage('first', 'a'.repeat(60000)), makeMessage('later', `NEVER-SENT-${'b'.repeat(30000)}`)]),
  );
  assert.ok(prepared);
  assert.equal(prepared.prompts.length, 1);
  assert.ok(prepared.prompts[0].includes('a'.repeat(60000)));
  assert.ok(!prepared.prompts[0].includes('NEVER-SENT'));
  assert.deepEqual(
    prepared.input.messages.map((m) => m.id),
    ['first'],
  );
});

test('an oversized message is fully chunked including its tail before reporting input coverage', () => {
  const prepared = prepareAbstractiveBatch(input([makeMessage('oversized', `${'x'.repeat(170000)}FINAL-TAIL`)]));
  assert.ok(prepared);
  assert.ok(prepared.prompts.length >= 3);
  assert.ok(prepared.prompts.at(-1)?.includes('FINAL-TAIL'));
  assert.ok(prepared.prompts.reduce((n, p) => n + (p.match(/x/g)?.length ?? 0), 0) >= 170000);
  assert.deepEqual(
    prepared.input.messages.map((m) => m.id),
    ['oversized'],
  );
});

test('summary output keeps its complete tail and each candidate resolves its own source', () => {
  const result = parseNaturalLanguageOutput(
    '# Complete\n\n' +
      '文'.repeat(1200) +
      'OUTPUT-TAIL\n\n## Durable Knowledge\n' +
      '[decision!] Sources belong to each claim — First claim [sources: m2]\n' +
      '[lesson] Recovery requires actual evidence — Second claim [sources: m1, m2]',
    input([makeMessage('m1', 'first'), makeMessage('m2', 'second')]),
  );
  assert.ok(result?.segments[0].summary.endsWith('OUTPUT-TAIL'));
  assert.deepEqual(
    result?.segments[0].candidates?.map((c) => c.evidence.map((e) => e.messageId)),
    [['m2'], ['m1', 'm2']],
  );
  assert.equal(result?.segments[0].candidates?.[0].claim, 'First claim');
});

test('every quoted or comment fragment repeats its own author after splitting', () => {
  const attachment = {
    ...quote.contentBlocks[0].attachment,
    text: `${'q'.repeat(90000)}QUOTE-TAIL`,
    comment: `${'c'.repeat(90000)}COMMENT-TAIL`,
  };
  const prepared = prepareAbstractiveBatch({
    ...input(),
    messages: [
      {
        ...quote,
        contentBlocks: [{ type: 'context_attachment', attachment }],
        quotedAuthors: { [attachment.id]: 'opus55' },
      },
    ],
  });
  assert.ok(prepared);
  assert.match(prepared.prompts.find((p) => p.includes('QUOTE-TAIL')) ?? '', /Quoted text; author opus55/);
  assert.match(prepared.prompts.find((p) => p.includes('COMMENT-TAIL')) ?? '', /Comment author user/);
});

test('missing or fabricated candidate sources are not guessed from the first message', () => {
  const result = parseNaturalLanguageOutput(
    '# Evidence\n\nSome useful summary.\n' +
      '[decision] A claim with no evidence — unknown\n' +
      '[lesson] A claim with invented evidence — unknown [sources: not-in-input]',
    input(),
  );
  assert.equal(result?.segments[0].candidates?.length ?? 0, 0);
});

test('real attachment comment survives index backfill and canonical message recall', async () => {
  assert.ok(buildSearchableMessageContent(quote).includes('钛合金裤衩子'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const thread = {
    id: quote.threadId,
    title: 'F321 source',
    createdBy: 'default-user',
    participants: [],
    lastActiveAt: quote.timestamp,
  };
  try {
    const builder = new IndexBuilder(
      store,
      process.cwd(),
      undefined,
      undefined,
      () => [thread],
      () => [quote],
    );
    // Upgrade an already-indexed passage whose projection omitted the paired comment.
    store
      .getDb()
      .prepare(
        'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        `thread-${thread.id}`,
        `msg-${quote.id}`,
        quote.contentBlocks[0].attachment.text,
        'user',
        0,
        new Date(quote.timestamp).toISOString(),
      );
    builder.markThreadDirty(thread.id);
    await builder.flushDirtyThreads();
    const service = new MessageSearchService({
      evidenceStore: store,
      messageStore: { getById: () => quote },
      threadStore: { get: () => thread, list: () => [thread] },
    });
    const result = await service.search(
      { query: '钛合金裤衩子', threadId: thread.id, mode: 'lexical', limit: 5 },
      { userId: 'default-user', viewer: { type: 'user' } },
    );
    assert.equal(result.results[0]?.messageId, quote.id);
    assert.ok(result.results[0]?.snippet.text.includes('钛合金裤衩子'));
    assert.equal(result.results[0]?.speaker, 'user');
    assert.equal(result.results[0]?.snippet.source, 'attachment-text');
    const app = Fastify();
    try {
      await app.register(evidenceRoutes, { evidenceStore: store, messageSearchService: service });
      const response = await app.inject({
        url: `/api/evidence/search?${new URLSearchParams({ q: '钛合金裤衩子', resultUnit: 'message', threadId: thread.id, mode: 'lexical' })}`,
        headers: { 'x-cat-cafe-user': 'default-user' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().results[0]?.messageId, quote.id);
      assert.ok(response.json().results[0]?.snippet.text.includes('钛合金裤衩子'));
    } finally {
      await app.close();
    }
  } finally {
    await store.close();
  }
});
