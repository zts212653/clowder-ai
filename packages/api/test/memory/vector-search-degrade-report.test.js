import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';
import {
  describeVectorSearchFailure,
  logVectorSearchDegradesTo,
  onVectorSearchDegrade,
  publishVectorSearchDegrade,
} from '../../dist/domains/memory/vector-search-degrade-report.js';

const QUERY = 'piano';
const PRIVATE = 'private-user-text-must-not-be-logged';

// Synthetic stand-ins for user text. A single word passes any "looks like an identifier" filter.
const PRIVATE_WORD = 'PRIVATE_QUERY_SENTINEL_7831';
const OTHER_WORD = 'UNRELATED_QUERY_4402';
const FIELDS = ['errorCategory', 'errorCode', 'errorName', 'stage'];

describe('describeVectorSearchFailure', () => {
  it('classifies the fixed vector-path failures into fixed labels', () => {
    const cases = [
      ['Vector projection is not ready', 'vector_projection_not_ready'],
      ['EmbeddingService not ready — embed-api server not available', 'embedding_not_ready'],
      ['Embedding service unavailable', 'embedding_not_ready'],
      ['fetch failed', 'embed_api_unreachable'],
      ['Vector generation table is unavailable or has the wrong dimension', 'vector_generation_unavailable'],
      ['Vector generation identity mismatch or unknown', 'vector_generation_unavailable'],
      [`Embed API error: 503 Service Unavailable — ${PRIVATE}`, 'embed_api_http_503'],
      ['Embed API error: 999 nonsense', 'embed_api_http_other'],
      ['Embedding loaded identity changed', 'embedding_response_or_identity'],
      [`something else entirely ${PRIVATE}`, 'other'],
    ];
    for (const [message, category] of cases) {
      assert.deepEqual(
        describeVectorSearchFailure('summary_hybrid', new Error(message)),
        { stage: 'summary_hybrid', errorName: 'Error', errorCode: null, errorCategory: category },
        message,
      );
    }
  });

  it('the record has exactly four fields: nothing located in or hashed from the error text', () => {
    const record = describeVectorSearchFailure('summary_hybrid', new Error(PRIVATE));
    assert.deepEqual(Object.keys(record).sort(), FIELDS);
  });

  it('a message that echoes the query on a line shaped like a stack frame leaves no trace of it', () => {
    // error.stack starts with the message, so its first "at " line can be the user's text.
    const echoed = (query) =>
      new Error(`Embed API error: 503 Service Unavailable — provider rejected text\n    at ${query}`);
    const record = describeVectorSearchFailure('summary_hybrid', echoed(PRIVATE_WORD));
    assert.ok(!JSON.stringify(record).includes(PRIVATE_WORD));
    assert.deepEqual(record, {
      stage: 'summary_hybrid',
      errorName: 'Error',
      errorCode: null,
      errorCategory: 'embed_api_http_503',
    });
  });

  it('two errors that differ only in the text they carry are indistinguishable, so no candidate can be confirmed', () => {
    const shapes = [
      (query) => new Error(`Embed API error: 503 Service Unavailable — provider rejected text\n    at ${query}`),
      (query) => new Error(`fts5: syntax error near "${query}"`),
      (query) => new Error(query),
      (query) => Object.assign(new Error('safe'), { name: query, code: query }),
      (query) => query,
    ];
    for (const shape of shapes) {
      assert.deepEqual(
        describeVectorSearchFailure('raw_passage_hybrid', shape(PRIVATE_WORD)),
        describeVectorSearchFailure('raw_passage_hybrid', shape(OTHER_WORD)),
      );
    }
  });

  it('an error class or code outside the fixed lists is recorded as other, even when it is a single plain word', () => {
    const wordy = Object.assign(new Error('safe error'), { name: PRIVATE_WORD, code: PRIVATE_WORD });
    assert.deepEqual(describeVectorSearchFailure('summary_semantic', wordy), {
      stage: 'summary_semantic',
      errorName: 'other',
      errorCode: 'other',
      errorCategory: 'other',
    });
    const numeric = Object.assign(new Error('safe error'), { code: 7831 });
    assert.equal(describeVectorSearchFailure('summary_semantic', numeric).errorCode, 'other');
  });

  it('keeps listed classes and codes, collapsing extended SQLite codes to their primary code', () => {
    const sqlite = (code) =>
      Object.assign(new Error(`fts5: syntax error near "${PRIVATE}"`), { name: 'SqliteError', code });
    assert.deepEqual(describeVectorSearchFailure('raw_passage_semantic', sqlite('SQLITE_ERROR')), {
      stage: 'raw_passage_semantic',
      errorName: 'SqliteError',
      errorCode: 'SQLITE_ERROR',
      errorCategory: 'sqlite',
    });
    assert.equal(
      describeVectorSearchFailure('summary_hybrid', sqlite('SQLITE_BUSY_SNAPSHOT')).errorCode,
      'SQLITE_BUSY',
    );
    assert.equal(
      describeVectorSearchFailure('summary_hybrid', sqlite('SQLITE_IOERR_SHORT_READ')).errorCode,
      'SQLITE_IOERR',
    );
    assert.equal(
      describeVectorSearchFailure('summary_hybrid', sqlite(`SQLITE_ERROR_${PRIVATE_WORD}`)).errorCode,
      'SQLITE_ERROR',
    );
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9880'), { code: 'ECONNREFUSED' });
    assert.equal(describeVectorSearchFailure('summary_hybrid', refused).errorCode, 'ECONNREFUSED');
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assert.equal(describeVectorSearchFailure('summary_hybrid', timeout).errorCategory, 'aborted_or_timed_out');
  });

  it('describes a thrown non-error without looking at it', () => {
    assert.deepEqual(describeVectorSearchFailure('summary_hybrid', PRIVATE), {
      stage: 'summary_hybrid',
      errorName: 'non_error',
      errorCode: null,
      errorCategory: 'other',
    });
  });
});

describe('a vector search that falls back to lexical says why (in-process store)', () => {
  let store;
  let vectorStore;
  let records;
  let unsubscribe;

  const embedding = (overrides = {}) => ({
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    embed: async () => [new Float32Array([1, 0, 0])],
    getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 3 }),
    ...overrides,
  });
  const degradeRecords = () => records;

  beforeEach(async () => {
    records = [];
    unsubscribe = onVectorSearchDegrade((record) => records.push(record));
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectorStore = new VectorStore(db, 3);
    await store.upsert([
      {
        anchor: 'repair-note',
        kind: 'decision',
        status: 'active',
        title: 'piano repair',
        updatedAt: '2026-10-08T00:00:00Z',
      },
    ]);
  });

  afterEach(() => {
    unsubscribe();
    store.close();
  });

  for (const mode of ['semantic', 'hybrid']) {
    it(`${mode}: the provider answering 503 is recorded as that, once, without the query or the response text`, async () => {
      store.setEmbedDeps({
        mode: 'on',
        vectorStore,
        embedding: embedding({
          embed: async () => {
            throw new Error(`Embed API error: 503 Service Unavailable — ${PRIVATE}`);
          },
        }),
      });
      const result = await store.searchWithMeta(QUERY, { mode });
      assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
      assert.deepEqual(
        result.items.map((item) => item.anchor),
        ['repair-note'],
        'lexical results are still served',
      );
      const records = degradeRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].stage, `summary_${mode}`);
      assert.equal(records[0].errorCategory, 'embed_api_http_503');
      const line = JSON.stringify(records[0]);
      assert.ok(!line.includes(PRIVATE) && !line.includes(QUERY), line);
    });
  }

  it('hybrid: a vector query that fails after the query was embedded is recorded under its stage', async () => {
    // The 2026-11-15 shape: the embed succeeds, the search still degrades.
    store.setEmbedDeps({
      mode: 'on',
      embedding: embedding(),
      vectorStore: {
        search: () => {
          throw new Error(PRIVATE);
        },
      },
    });
    const result = await store.searchWithMeta(QUERY, { mode: 'hybrid' });
    assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
    const records = degradeRecords();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      stage: 'summary_hybrid',
      errorName: 'Error',
      errorCode: null,
      errorCategory: 'other',
    });
    assert.ok(!JSON.stringify(records[0]).includes(PRIVATE));
  });

  it('a failed availability probe is recorded too, under its own stage', async () => {
    store.setEmbedDeps({
      mode: 'on',
      vectorStore,
      embedding: embedding({
        isReady: () => false,
        reprobeIfNeeded: async () => {
          throw new Error('EmbeddingService not ready — embed-api server not available');
        },
      }),
    });
    const result = await store.searchWithMeta(QUERY, { mode: 'hybrid' });
    assert.equal(result.meta.degradeReason, 'passage_embedding_unavailable');
    const records = degradeRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].stage, 'embedding_availability');
    assert.equal(records[0].errorCategory, 'embedding_not_ready');
  });

  it('a provider that is simply not ready is the expected state and records nothing', async () => {
    store.setEmbedDeps({ mode: 'on', vectorStore, embedding: embedding({ isReady: () => false }) });
    const result = await store.searchWithMeta(QUERY, { mode: 'hybrid' });
    assert.equal(result.meta.degradeReason, 'passage_embedding_unavailable');
    assert.deepEqual(degradeRecords(), []);
  });

  it('a search the caller cancelled is rethrown, not recorded as a degrade', async () => {
    const controller = new AbortController();
    store.setEmbedDeps({
      mode: 'on',
      vectorStore,
      embedding: embedding({
        embed: async () => {
          controller.abort(new Error('caller went away'));
          throw new Error('aborted mid-embed');
        },
      }),
    });
    await assert.rejects(store.searchWithMeta(QUERY, { mode: 'hybrid', signal: controller.signal }));
    assert.deepEqual(degradeRecords(), []);
  });
});

describe('the API logs each published degrade once', () => {
  const record = describeVectorSearchFailure('summary_hybrid', new Error('Vector projection is not ready'));

  it('writes one structured warning per degrade and stops when unsubscribed', () => {
    const calls = [];
    const stop = logVectorSearchDegradesTo({ warn: (fields, message) => calls.push([fields, message]) });
    publishVectorSearchDegrade(record);
    stop();
    publishVectorSearchDegrade(record);
    assert.deepEqual(calls, [[{ module: 'memory-vector-search', ...record }, 'Vector search degraded to lexical']]);
    assert.equal(calls[0][0].errorCategory, 'vector_projection_not_ready');
  });
});
