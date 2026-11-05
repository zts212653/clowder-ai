import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactReviewRound } from '@cat-cafe/shared';
import { isModificationResultRound } from '../src/domains/collaborative-content/modification/media-response-round.js';

// A v1 request survives a later round's independent request; v4 explicitly responds to v1.
const response = {
  number: 3,
  responseSource: { round: 1, ownerRevision: 1, reviewRevision: 9, requestId: 'original-request' },
} as ArtifactReviewRound;
const source = { requestId: 'original-request', round: 1, reviewRevision: 3, lastResultRound: 2 };
test('an explicit Work response belongs to its original request across intervening rounds, never a sibling request', () => {
  assert.equal(isModificationResultRound(response, source), true);
  assert.equal(
    isModificationResultRound(response, { ...source, requestId: 'new-request', lastResultRound: Infinity }),
    false,
  );
  assert.equal(isModificationResultRound(response, { ...source, round: 2, lastResultRound: Infinity }), false);
  assert.equal(
    isModificationResultRound(response, { ...source, reviewRevision: 10, lastResultRound: Infinity }),
    false,
  );
});
test('legacy responses keep their original request interval', () => {
  assert.equal(isModificationResultRound({ number: 2 } as ArtifactReviewRound, source), true);
  assert.equal(isModificationResultRound({ number: 3 } as ArtifactReviewRound, source), false);
});
