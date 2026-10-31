import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entrustedWorkOwnerReadV1Schema } from '@cat-cafe/shared';
import { tomorrowsPptOwnerReadFixture } from '../fixtures/growing/tomorrows-ppt.js';

function resolveFixtureRef(root, ref) {
  assert.match(ref, /^#\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/);
  return ref
    .slice(2)
    .split('/')
    .reduce((value, segment) => value[segment], root);
}

describe('F310 owner-read Web/cat parity fixture', () => {
  it('is explicitly deterministic evidence rather than a relabeled runtime episode', () => {
    assert.equal(tomorrowsPptOwnerReadFixture.fixtureClass, 'deterministic_contract_fixture');
    assert.equal(tomorrowsPptOwnerReadFixture.runtimeEpisode, false);
    assert.equal(tomorrowsPptOwnerReadFixture.utilityEvidence, false);
  });

  it('validates quiet, actionable, and resolved views through one shared contract', () => {
    for (const snapshot of Object.values(tomorrowsPptOwnerReadFixture.snapshots)) {
      assert.deepEqual(entrustedWorkOwnerReadV1Schema.parse(snapshot), snapshot);
    }
  });

  it('keeps Task revision stable while producer eligibility changes and resolves', () => {
    const { quiet, actionable, resolved } = tomorrowsPptOwnerReadFixture.snapshots;
    assert.deepEqual([quiet.envelope.revision, actionable.envelope.revision, resolved.envelope.revision], [7, 7, 7]);
    assert.deepEqual(
      [
        quiet.attentionReceipts[0].producer.revision,
        actionable.attentionReceipts[0].producer.revision,
        resolved.attentionReceipts[0].producer.revision,
      ],
      [11, 12, 13],
    );
    assert.equal(quiet.attentionReceipts[0].eligible, false);
    assert.equal(actionable.attentionReceipts[0].eligible, true);
    assert.equal(resolved.attentionReceipts[0].eligible, false);
  });

  it('gives Web Schedule, Web Needs Me, and cat tools the exact same owner refs and revisions', () => {
    const { projectionRefs } = tomorrowsPptOwnerReadFixture;
    const webSchedule = resolveFixtureRef(tomorrowsPptOwnerReadFixture, projectionRefs.webSchedule);
    const webNeedsMe = resolveFixtureRef(tomorrowsPptOwnerReadFixture, projectionRefs.webNeedsMe);
    const catOwnerRead = resolveFixtureRef(tomorrowsPptOwnerReadFixture, projectionRefs.catOwnerRead);

    assert.strictEqual(webSchedule, webNeedsMe);
    assert.strictEqual(webNeedsMe, catOwnerRead);
    assert.equal(webNeedsMe.envelope.subjectRef, 'task:work:tomorrows-ppt');
    assert.equal(webNeedsMe.envelope.revision, 7);
    assert.equal(webNeedsMe.preparedArtifact.artifactRevision, '7');
    assert.deepEqual(
      webNeedsMe.timeRefs.map(({ role, subjectRef, ownerRef, revision }) => ({
        role,
        subjectRef,
        ownerRef,
        revision,
      })),
      catOwnerRead.timeRefs.map(({ role, subjectRef, ownerRef, revision }) => ({
        role,
        subjectRef,
        ownerRef,
        revision,
      })),
    );
  });
});
