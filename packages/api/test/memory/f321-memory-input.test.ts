import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  createAbstractiveClient,
  parseNaturalLanguageOutput,
} from '../../src/domains/memory/AbstractiveSummaryClient.js';
import { toAbstractiveMessages } from '../../src/domains/memory/abstractive-summary-input.js';
import { IndexBuilder } from '../../src/domains/memory/IndexBuilder.js';
import { MessageSearchService } from '../../src/domains/memory/MessageSearchService.js';
import { buildSearchableMessageContent } from '../../src/domains/memory/message-search-content.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import { evidenceRoutes } from '../../src/routes/evidence.js';

const quote = JSON.parse(readFileSync(new URL('./fixtures/f321-quote-comment.json', import.meta.url), 'utf8'));
const logger = { info() {}, error() {} };
const makeMessage = (id: string, content: string) => ({ id, content, timestamp: 1000 });
const input = (messages = [makeMessage('m1', 'hello')]) => ({
  threadId: 'fixture',
  previousSummary: null,
  messages,
});

async function withClient(
  run: (client: ReturnType<typeof createAbstractiveClient>, prompts: string[]) => Promise<void>,
  response = '# Full summary\n\nNothing was lost.',
) {
  const prior = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)).messages[0].content);
    return Response.json({ content: [{ type: 'text', text: response }], stop_reason: 'end_turn' });
  };
  try {
    const client = createAbstractiveClient(
      async () => ({ mode: 'api_key', baseUrl: 'https://fixture.invalid', apiKey: 'fixture' }),
      logger,
    );
    await run(client, prompts);
  } finally {
    globalThis.fetch = prior;
  }
}

test('empty body still sends the real quote and owner comment with distinct authors', async () => {
  await withClient(async (client, prompts) => {
    const messages = await toAbstractiveMessages([quote], {
      getById: () => ({ ...quote, id: quote.contentBlocks[0].attachment.source.messageId, catId: 'opus55' }),
    });
    await client({ ...input(), messages });
    assert.ok(prompts[0].includes(quote.contentBlocks[0].attachment.text));
    assert.ok(prompts[0].includes(quote.contentBlocks[0].attachment.comment));
    assert.match(prompts[0], /opus55/);
    assert.match(prompts[0], /comment author.*user/i);
    assert.ok(prompts[0].includes(quote.id));
  });
});

test('the real long source includes all 1547 characters and its final line in the provider request', async () => {
  const message = JSON.parse(readFileSync(new URL('./fixtures/f321-long-message.json', import.meta.url), 'utf8'));
  await withClient(async (client, prompts) => {
    await client({ ...input(), threadId: message.threadId, messages: [message] });
    assert.ok(message.content.length > 1000);
    assert.ok(prompts[0].includes(message.content));
    assert.ok(prompts[0].includes(message.content.slice(-100)));
  });
});

test('a message beyond 1000 characters includes its complete tail', async () => {
  const content = `${'长'.repeat(3000)}TAIL-MUST-BE-READ`;
  await withClient(async (client, prompts) => {
    const result = await client(input([makeMessage('long', content)]));
    assert.ok(prompts.join('').includes(content));
    assert.equal(result?.segments[0].toMessageId, 'long');
  });
});

test('a bounded batch only reports the fully sent prefix; later messages remain pending', async () => {
  await withClient(async (client, prompts) => {
    const result = await client(
      input([makeMessage('first', 'a'.repeat(60000)), makeMessage('later', `NEVER-SENT-${'b'.repeat(30000)}`)]),
    );
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('a'.repeat(60000)));
    assert.ok(!prompts[0].includes('NEVER-SENT'));
    assert.equal(result?.segments[0].toMessageId, 'first');
    assert.equal(result?.segments[0].messageCount, 1);
  });
});

test('an oversized single message is fully chunked including the tail before reporting coverage', async () => {
  await withClient(async (client, prompts) => {
    const result = await client(input([makeMessage('oversized', `${'x'.repeat(170000)}FINAL-TAIL`)]));
    assert.ok(prompts.length >= 3);
    assert.ok(prompts.at(-1)?.includes('FINAL-TAIL'));
    assert.equal(prompts.reduce((n, p) => n + (p.match(/x/g)?.length ?? 0), 0) >= 170000, true);
    assert.equal(result?.segments.length, 1);
    assert.equal(result?.segments[0].messageCount, 1);
  });
});

test('summary output keeps content after 800 characters and each candidate resolves its own source', () => {
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

test('every quoted or comment fragment repeats its own author after splitting', async () => {
  const attachment = {
    ...quote.contentBlocks[0].attachment,
    text: `${'q'.repeat(90000)}QUOTE-TAIL`,
    comment: `${'c'.repeat(90000)}COMMENT-TAIL`,
  };
  await withClient(async (client, prompts) => {
    await client({
      ...input(),
      messages: [
        {
          ...quote,
          contentBlocks: [{ type: 'context_attachment', attachment }],
          quotedAuthors: { [attachment.id]: 'opus55' },
        },
      ],
    });
    assert.match(prompts.find((p) => p.includes('QUOTE-TAIL')) ?? '', /Quoted text; author opus55/);
    assert.match(prompts.find((p) => p.includes('COMMENT-TAIL')) ?? '', /Comment author user/);
  });
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
