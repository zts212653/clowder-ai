import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovedTaskContinuationUnavailable } from '../dist/domains/ball-custody/approved-task-continuation-diagnostics.js';
import { parseApprovedTaskImplementationHistory } from '../dist/domains/ball-custody/approved-task-implementation-history.js';

const target = { tenantScope: 'current-user', subjectRef: 'subject:task:current' };
const key = 'action:successor:detail:prior';
const original = {
  leaseId: 'prior',
  key: 'canonical-identity',
  generation: 1,
  ...target,
  actionFamily: 'implement',
  holderThreadId: 'approved-child',
  evidenceRefs: ['proposal:approved:source'],
};
const envelope = (value) =>
  JSON.stringify({ _invalidRaw: value, disposition: 'needs_attention', reasonCode: 'malformed_lease' });

test('retained matching history still exposes all original approval-use evidence', () => {
  const raw = JSON.stringify(original);
  assert.deepEqual(
    parseApprovedTaskImplementationHistory(envelope(raw), target, key),
    parseApprovedTaskImplementationHistory(raw, target, key),
  );
});

for (const field of ['tenantScope', 'subjectRef']) {
  test(`retained history cannot be skipped without a valid ${field}`, () => {
    const invalid = { ...original, subjectRef: 'subject:task:unrelated' };
    delete invalid[field];
    assert.throws(
      () => parseApprovedTaskImplementationHistory(envelope(JSON.stringify(invalid)), target, key),
      (error) => error instanceof ApprovedTaskContinuationUnavailable && error.diagnostic.stage === 'identity',
    );
  });
}

const failures = [
  ['missing', null],
  ['json', '{secret-original-broken'],
  ['missing', envelope(null)],
  ['json', envelope('{secret-original-broken')],
  ['identity', envelope(envelope(JSON.stringify(original)))],
  ['recovery_envelope', JSON.stringify({ _invalidRaw: JSON.stringify(original) })],
  ['recovery_envelope', JSON.stringify({ ...JSON.parse(envelope(JSON.stringify(original))), ...original })],
  ['provenance', envelope(JSON.stringify({ ...original, evidenceRefs: 'secret-original-broken' }))],
];
for (const [index, [stage, raw]] of failures.entries()) {
  test(`unavailable history records only its stage and key digest: ${index}/${stage}`, () => {
    assert.throws(
      () => parseApprovedTaskImplementationHistory(raw, target, key),
      (error) => {
        assert.ok(error instanceof ApprovedTaskContinuationUnavailable);
        assert.equal(error.diagnostic.stage, stage);
        assert.equal(error.diagnostic.object, 'implementation_history');
        assert.match(error.diagnostic.keyDigest, /^[a-f0-9]{16}$/);
        assert.doesNotMatch(JSON.stringify(error), /secret-original|current-user|subject:task|action:successor/);
        return true;
      },
    );
  });
}

for (const detailKey of [undefined, `${key}-other`])
  test(`retained bytes require their exact canonical row: ${detailKey}`, () => {
    assert.throws(
      () => parseApprovedTaskImplementationHistory(envelope(JSON.stringify(original)), target, detailKey),
      (error) => error instanceof ApprovedTaskContinuationUnavailable && error.diagnostic.stage === 'identity',
    );
  });

test('unrelated retained identity does not require matching-proposal provenance', () => {
  const raw = JSON.stringify({ ...original, subjectRef: 'subject:task:unrelated', evidenceRefs: 'legacy-provenance' });
  assert.equal(parseApprovedTaskImplementationHistory(envelope(raw), target, key), null);
});
