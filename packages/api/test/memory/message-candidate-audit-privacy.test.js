import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryReadExecution } from '../../dist/domains/memory/memory-read-execution.js';
import {
  MessageCandidateAudit,
  ownerCandidateAuditRequest,
} from '../../dist/domains/memory/message-candidate-audit.js';
import {
  CANDIDATE_AUDIT_MAX_BYTES,
  safeCandidateAudit,
} from '../../dist/domains/memory/message-candidate-audit-wire.js';
import { MessageSearchCandidateDiagnostics } from '../../dist/domains/memory/message-search-candidate-diagnostics.js';
import { MessageSearchDiagnostics } from '../../dist/domains/memory/message-search-diagnostics.js';

const id = '11111111-2222-4333-8444-555555555555';
const otherId = '21111111-2222-4333-8444-555555555555';
const executionId = '31111111-2222-4333-8444-555555555555';
const coordinate = { docAnchor: 'thread-private-fixture', passageId: 'msg-private-fixture' };
const revision = 'b1'.repeat(32);

function environment(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const before = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}
const enable = (t) =>
  environment(t, {
    TELEMETRY_HMAC_SALT: 'fixture-explicit-installation-secret-'.repeat(2),
    TELEMETRY_EXPORT_RAW_SYSTEM_IDS: '1',
  });
function worker(request, rows = [coordinate]) {
  const audit = MessageCandidateAudit.create(request, 2000);
  audit.order(1, rows);
  audit.order(5, rows);
  return { executionId, outcome: 'fulfilled', candidateAudit: audit.snapshot() };
}

test('domain binding prevents request/owner reuse, even with the same request UUID and raw-ID export enabled', (t) => {
  enable(t);
  const left = ownerCandidateAuditRequest(id, 'owner-a');
  const acrossOwner = ownerCandidateAuditRequest(id, 'owner-b');
  const acrossRequest = ownerCandidateAuditRequest(otherId, 'owner-a');
  const snapshots = [left, acrossOwner, acrossRequest].map((request) => worker(request).candidateAudit);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.rows[0][0])).size, 3);
  const receiver = MessageCandidateAudit.create(left, 2000);
  assert.equal(receiver.adopt(snapshots[1]), false);
  assert.equal(receiver.adopt(snapshots[2]), false);
  assert.equal(receiver.adopt(snapshots[0]), true);
  const serialized = JSON.stringify(snapshots);
  assert.doesNotMatch(serialized, /owner-a|owner-b|thread-private|msg-private|installation-secret/);
  for (const request of [left, acrossOwner, acrossRequest]) assert.ok(!serialized.includes(request.key));
});

test('a host rejection erases its identity and revision from every earlier phase; one full event only', (t) => {
  enable(t);
  const traces = [];
  const host = new MessageSearchCandidateDiagnostics(id, 'owner-a', (trace) => traces.push(trace));
  const snapshot = worker(host.request);
  const fingerprint = snapshot.candidateAudit.rows[0][0];
  host.worker(snapshot);
  const row = { candidate: coordinate, contentRevision: revision };
  host.projection(coordinate, row);
  host.window([row]);
  host.final(row, null); // The existing owner projector supplies no reliable finer-grained reason.
  host.publish();
  host.publish();
  host.close();
  host.publish();
  assert.equal(traces.length, 1);
  assert.ok(!JSON.stringify(traces).includes(fingerprint));
  assert.ok(!JSON.stringify(traces).includes(revision));
  assert.equal(traces[0].candidateAudit.rows[0][0], null);
  assert.deepEqual(traces[0].candidateAudit.canonical.at(-1).slice(1), ['final', 'owner_projection_rejected', null]);
});

test('retirement replaces the first worker evidence; summaries, errors and closed observers never retain a matrix', (t) => {
  enable(t);
  const traces = [];
  const diagnostics = new MessageSearchDiagnostics((trace) => traces.push(trace), { searchId: id, ownerId: 'owner-a' });
  const first = worker(diagnostics.candidateEvidence.request);
  const second = worker(diagnostics.candidateEvidence.request, [
    { docAnchor: 'thread-second', passageId: 'msg-second' },
  ]);
  second.executionId = otherId;
  diagnostics.worker(first);
  diagnostics.worker(second);
  diagnostics.trace({ phase: 'retrieval' });
  assert.ok(diagnostics.snapshot().workerReads.every((row) => !('candidateAudit' in row)));
  diagnostics.candidateEvidence.publish();
  assert.equal(traces.at(-1).readerExecutionId, otherId);
  assert.deepEqual(traces.at(-1).candidateAudit.rows, second.candidateAudit.rows);
  diagnostics.close();
  diagnostics.worker(first);
  diagnostics.candidateEvidence.publish();
  assert.equal(traces.length, 2);
  const execution = new MemoryReadExecution('message-search');
  execution.observe({ phase: 'candidate-audit', candidateAudit: first.candidateAudit });
  assert.ok(!('candidateAudit' in execution.snapshot('pending')));
  assert.ok(!('candidateAudit' in execution.snapshot('rejected')));
  const error = new Error('controlled reader failure');
  execution.annotate(error);
  assert.ok(!JSON.stringify(error).includes(first.candidateAudit.rows[0][0]));
});

test('no explicit adequate salt is identity_unavailable even in dev/test; a throwing sink is harmless', (t) => {
  environment(t, { TELEMETRY_HMAC_SALT: undefined, NODE_ENV: 'test', TELEMETRY_EXPORT_RAW_SYSTEM_IDS: '1' });
  assert.equal(ownerCandidateAuditRequest(id, 'owner-a'), undefined);
  const traces = [];
  const host = new MessageSearchCandidateDiagnostics(id, 'owner-a', (trace) => traces.push(trace));
  assert.equal(host.request, undefined);
  host.publish();
  assert.deepEqual(traces, [{ phase: 'candidate-audit', searchId: id, state: 'identity_unavailable' }]);
  process.env.TELEMETRY_HMAC_SALT = 'short';
  assert.equal(ownerCandidateAuditRequest(id, 'owner-a'), undefined);
  assert.doesNotThrow(() =>
    new MessageSearchCandidateDiagnostics(id, 'owner-a', () => {
      throw new Error('observer only');
    }).publish(),
  );
  assert.equal(
    safeCandidateAudit({
      get id() {
        throw new Error('observer getter');
      },
    }),
    undefined,
  );
});

test('the IPC whitelist also erases a failed producer matrix before adoption or error observation', (t) => {
  enable(t);
  const oldProducer = worker(ownerCandidateAuditRequest(id, 'owner-a')).candidateAudit;
  const fingerprint = oldProducer.rows[0][0];
  oldProducer.nativeState = 'failed'; // An old producer may have observed native hits before its catch.
  const safe = safeCandidateAudit(oldProducer);
  assert.equal(safe.state, 'capture_incomplete');
  assert.deepEqual(safe.rows, []);
  assert.deepEqual(safe.canonical, []);
  assert.ok(!JSON.stringify(safe).includes(fingerprint));
});

test('fixed row/operation/byte caps report incomplete evidence instead of an absence claim', (t) => {
  enable(t);
  const audit = MessageCandidateAudit.create(ownerCandidateAuditRequest(id, 'owner-a'), 2);
  audit.order(1, [coordinate]);
  for (let n = 0; n < 12; n++) audit.nativeCoordinate({ docAnchor: 'thread-bounded', passageId: `msg-${n}` }, n + 1);
  for (let n = 0; n < 2200; n++) audit.final(coordinate, revision, revision);
  const snapshot = audit.snapshot();
  assert.equal(snapshot.state, 'capture_incomplete');
  assert.ok(snapshot.rows.length <= 4);
  assert.ok(snapshot.canonical.length <= snapshot.canonicalLimit);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= CANDIDATE_AUDIT_MAX_BYTES);
  const full = MessageCandidateAudit.create(ownerCandidateAuditRequest(otherId, 'owner-a'), 2000);
  const many = Array.from({ length: 4000 }, (_, n) => ({ docAnchor: 'thread-limit', passageId: `msg-${n}` }));
  full.order(4, many);
  for (const row of many.slice(0, 2064)) full.final(row, revision, revision);
  const bounded = full.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= CANDIDATE_AUDIT_MAX_BYTES);
  assert.ok(bounded.rows.length <= 4000);
  assert.equal(bounded.state, 'capture_incomplete', 'oversized complete tables must not silently disappear');
});
