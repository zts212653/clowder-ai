import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requestReviewAssetVersionRef } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-identity.js';
import { requestReviewSemanticVersion } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-port.js';
import { createRequestReviewCommitVersionVerifier } from '../dist/infrastructure/capability-evolution/change/request-review-owner-version-verifier.js';

function source(anchor, immutableGuard = 'immutable guard', packetInsertions = []) {
  return [
    '---',
    'name: request-review',
    '---',
    `Review-Subject-Ref: ${anchor}`,
    ...packetInsertions,
    'Accepted-Source-Ref: <canonical source>',
    'Accepted-Revision: <exact revision>',
    'Scope: outside the variable',
    '',
    'Feature 以 canonical docs/features/F*.md 为 anchor。',
    '',
    immutableGuard,
  ].join('\n');
}

function verifierFixture(candidateSource) {
  const commits = new Map([
    ['a'.repeat(40), source('<old>')],
    ['b'.repeat(40), candidateSource],
  ]);
  return createRequestReviewCommitVersionVerifier({
    gitHeadOid: async () => 'b'.repeat(40),
    gitBlobOidAt: async () => 'f'.repeat(40),
    readSkillFileAt: async (commit) => commits.get(commit),
    readMutableAcceptedSourceAt: async () => '',
    listFileHistoryAt: async () => [
      { commitOid: 'b'.repeat(40), blobOid: 'f'.repeat(40), committedAt: '2026-09-12T11:00:00Z', subject: 'candidate' },
      { commitOid: 'a'.repeat(40), blobOid: 'e'.repeat(40), committedAt: '2026-09-12T10:00:00Z', subject: 'baseline' },
    ],
  });
}

describe('request-review semantic transition verifier', () => {
  it('accepts only an anchor change whose immutable envelope remains byte-identical', async () => {
    const baseline = requestReviewAssetVersionRef(requestReviewSemanticVersion(source('<old>')));
    const candidateSource = source('<new>');
    const candidate = requestReviewAssetVersionRef(requestReviewSemanticVersion(candidateSource));
    assert.equal(
      await verifierFixture(candidateSource).verifyAllowedTransition(baseline, 'b'.repeat(40), candidate),
      true,
    );

    const driftedSource = source('<new>', 'changed deterministic guard');
    const drifted = requestReviewAssetVersionRef(requestReviewSemanticVersion(driftedSource));
    assert.equal(
      await verifierFixture(driftedSource).verifyAllowedTransition(baseline, 'b'.repeat(40), drifted),
      false,
    );

    const expandedPacket = source('<new>', 'immutable guard', ['Arbitrary-Permission: <anything>']);
    assert.equal(
      await verifierFixture(expandedPacket).verifyAllowedTransition(
        baseline,
        'b'.repeat(40),
        requestReviewAssetVersionRef('f'.repeat(64)),
      ),
      false,
      'the mutable packet cannot grow arbitrary fields merely because they sit between two anchor lines',
    );
  });
});
