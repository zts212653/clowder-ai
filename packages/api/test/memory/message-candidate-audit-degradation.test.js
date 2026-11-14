import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MemoryReadExecution } from '../../dist/domains/memory/memory-read-execution.js';
import {
  MessageCandidateAudit,
  ownerCandidateAuditRequest,
} from '../../dist/domains/memory/message-candidate-audit.js';
import { searchMessagePassages } from '../../dist/domains/memory/message-passage-search.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const hidden = { docAnchor: 'thread-hidden-source', passageId: 'msg-hidden-source' };
const request = { id: '11111111-2222-4333-8444-555555555555', key: 'a7'.repeat(32) };
const fingerprint = (scope) => {
  const audit = MessageCandidateAudit.create(scope, 2000);
  audit.nativeCoordinate(hidden, 1);
  return audit.snapshot().rows[0][0];
};

async function fixture(t) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  await store.upsert([
    { anchor: 'thread-visible', kind: 'thread', status: 'active', title: 'Neutral', updatedAt: '2026-01-01' },
  ]);
  store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?,?,?,?)')
    .run('thread-visible', 'msg-visible', 'needle neutral material', '2026-01-01T00:00:00Z');
  return store;
}

function failingVectors(db, beforeFailure = () => {}) {
  const fail = async (audit) => {
    audit?.nativeStarted();
    audit?.nativeCoordinate(hidden, 1); // Same boundary as real KNN before hydrate/admission SQL.
    audit?.nativeFinished(1);
    beforeFailure();
    throw new Error('controlled vector failure after raw NN observation');
  };
  return {
    db,
    isEmbeddingAvailable: async () => true,
    semanticSearch: (_limit, audit) => fail(audit),
    hybridSearch: (_lexical, _limit, _accept, _compare, audit) => fail(audit),
  };
}

for (const mode of ['semantic', 'hybrid'])
  test(`${mode} fallback after raw NN observation preserves lexical output and erases unadmitted identities`, async (t) => {
    const store = await fixture(t);
    const options = { visibleThreadIds: ['visible'], mode, candidateOrder: 'relevance' };
    const baseline = await searchMessagePassages('needle', options, failingVectors(store.getDb()));
    let snapshot;
    const observed = await searchMessagePassages(
      'needle',
      {
        ...options,
        candidateAudit: request,
        onCandidateAudit: (value) => {
          snapshot = value;
        },
      },
      failingVectors(store.getDb()),
    );
    assert.deepEqual(observed, baseline);
    assert.equal(observed.meta.degradeReason, 'passage_vector_search_error');
    assert.equal(observed.meta.effectiveMode, 'lexical');
    assert.equal(observed.passages.length, 1);
    assert.ok(
      !JSON.stringify(snapshot).includes(fingerprint(request)),
      'a failed native stage must not publish its unadmitted fingerprint',
    );
    assert.equal(snapshot.state, 'capture_incomplete');
    assert.deepEqual(snapshot.rows, []);
    assert.deepEqual(snapshot.canonical, []);
  });

test('the host final event and normal trace/error remain anonymous after degraded native capture, including abort', async (t) => {
  const previous = process.env.TELEMETRY_HMAC_SALT;
  process.env.TELEMETRY_HMAC_SALT = 'degradation-fixture-explicit-salt-'.repeat(2);
  t.after(() => {
    if (previous === undefined) delete process.env.TELEMETRY_HMAC_SALT;
    else process.env.TELEMETRY_HMAC_SALT = previous;
  });
  const store = await fixture(t);
  const thread = { id: 'visible', createdBy: 'owner', title: 'Neutral' };
  const traces = [];
  const service = new MessageSearchService({
    threadStore: { get: () => thread, list: () => [thread] },
    messageStore: {
      getById: () => ({
        id: 'visible',
        threadId: 'visible',
        userId: 'owner',
        content: 'needle neutral material',
        timestamp: 1000,
      }),
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async (query, options) => {
        const execution = new MemoryReadExecution('message-search');
        const result = await searchMessagePassages(
          query,
          {
            ...options,
            onCandidateAudit: (candidateAudit) => execution.observe({ phase: 'candidate-audit', candidateAudit }),
          },
          failingVectors(store.getDb()),
        );
        options.onReadSnapshot?.(execution.snapshot('fulfilled'));
        return result;
      },
    },
  });
  const caller = new AbortController();
  const result = await service.search(
    { query: 'needle', mode: 'hybrid' },
    { userId: 'owner', viewer: { type: 'user' } },
    { signal: caller.signal, onTrace: (trace) => traces.push(trace) },
  );
  assert.equal(caller.signal.aborted, false);
  assert.equal(result.results.length, 1);
  const event = traces.find((trace) => trace.phase === 'candidate-audit');
  assert.equal(event.candidateAudit.state, 'capture_incomplete');
  assert.deepEqual(event.candidateAudit.rows, []);
  assert.deepEqual(event.candidateAudit.canonical, []);
  assert.ok(!JSON.stringify(traces).includes(fingerprint(ownerCandidateAuditRequest(result.searchId, 'owner'))));
  assert.ok(traces.filter((trace) => trace.phase !== 'candidate-audit').every((trace) => !('candidateAudit' in trace)));
  const cancelled = new AbortController();
  const reason = new DOMException('controlled caller abort', 'AbortError');
  let reported = 0;
  await assert.rejects(
    searchMessagePassages(
      'needle',
      {
        visibleThreadIds: ['visible'],
        mode: 'hybrid',
        signal: cancelled.signal,
        candidateAudit: request,
        onCandidateAudit() {
          reported++;
        },
      },
      failingVectors(store.getDb(), () => cancelled.abort(reason)),
    ),
    (error) => error === reason,
  );
  assert.equal(reported, 0);
});
