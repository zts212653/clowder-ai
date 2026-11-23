import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberGroupRow } from '../dist/routes/remember-original-submission.js';

test('person revisions retain the owner subject needed to read their actual result, without copying its content', () => {
  for (const kind of ['claim', 'event']) {
    const row = rememberGroupRow(
      {
        itemId: 'revision',
        target: 'person_revision',
        statusCode: 200,
        result: {
          outcome: 'applied',
          [kind]: {
            [`${kind}Id`]: 'result-1',
            ...(kind === 'claim' ? { personId: 'person_1' } : { relationshipId: 'relationship-1' }),
            payload: { privateText: 'owner-only' },
          },
        },
      },
      {
        itemId: 'revision',
        target: 'person_revision',
        payload: { personId: 'person_1', action: kind === 'claim' ? 'correct_claim' : 'amend_event' },
      },
    );
    assert.equal(row.personId, 'person_1');
    assert.equal(row.resultRef, 'result-1');
    assert.equal(JSON.stringify(row).includes('owner-only'), false);
  }
});

test('a failed original revision does not turn its requested person into a displayed saved result', () => {
  const row = rememberGroupRow(
    { itemId: 'revision', target: 'person_revision', statusCode: 403, result: { error: 'forbidden' } },
    { itemId: 'revision', target: 'person_revision', payload: { personId: 'person_1', action: 'amend_event' } },
  );
  assert.equal(row.personId, undefined);
  assert.equal(row.resultRef, undefined);
});
