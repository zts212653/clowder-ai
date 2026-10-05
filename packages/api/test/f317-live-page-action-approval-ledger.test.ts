import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LivePageActionApprovalLedger } from '../src/domains/concierge/live/host/live-page-action-approval-ledger.js';
import { fixture, issueFixtureApproval } from './helpers/f317-page-action-fixture.js';

test('one per-call owner record verifies exact source, scope, action and expiry, then revokes', async () => {
  const f = fixture();
  const ledger = new LivePageActionApprovalLedger();
  const record = await issueFixtureApproval(ledger, f);
  const probe = { ...record, signal: new AbortController().signal };
  assert.equal(await ledger.verify(probe), true);
  assert.equal(await ledger.verify({ ...probe, requestRevision: 'b'.repeat(64) }), false);
  assert.equal(await ledger.verify({ ...probe, actionSha256: 'c'.repeat(64) }), false);
  assert.equal(await ledger.verify({ ...probe, scope: { ...record.scope, generation: 2 } }), false);
  assert.equal(await ledger.verify({ ...probe, expiresAtMs: record.expiresAtMs - 1 }), false);
  ledger.revoke(record.approvalId);
  assert.equal(await ledger.verify(probe), false);
  assert.throws(() => ledger.issue(record), /unavailable/, 'a revoked ID cannot be reissued');
});

test('a retired call closes its approval ledger and refuses further checks', async () => {
  const f = fixture();
  const ledger = new LivePageActionApprovalLedger();
  const record = await issueFixtureApproval(ledger, f);
  ledger.close();
  assert.equal(await ledger.verify({ ...record, signal: new AbortController().signal }), false);
  assert.throws(() => ledger.issue(record), /unavailable/);
});
