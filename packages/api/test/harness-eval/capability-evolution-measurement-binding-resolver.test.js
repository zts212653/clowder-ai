import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitCapabilityEvolutionMeasurementBindingResolver } from '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-binding-resolver.js';
import { writeYaml } from './capability-evolution-measurement-fixtures.js';
import { measurementBindingGitFixture } from './measurement-binding-git-fixture.js';

const evidenceProofRef = {
  ownerFeatureId: 'F267',
  ownerStateRef: 'measurement-proof:f267-capability-evolution-roadshow-e0-proof-v1',
};
const resolverFor = (fixture, mainRef = 'HEAD') =>
  createGitCapabilityEvolutionMeasurementBindingResolver({ repoRoot: fixture.repoRoot, mainRef, fetchMain: false });

describe('F267 trusted-main measurement constitution binding', () => {
  it('reopens an independently issued insufficient publication and derives exact canonical refs', async (t) => {
    const fixture = await measurementBindingGitFixture(t);
    const result = await resolverFor(fixture, fixture.publication.commitSha).resolveMeasurementConstitution({
      ownerUserId: 'operator',
      program: fixture.projection,
      evidenceProofRef,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.binding.measurementCertificateRef, {
      ownerFeatureId: 'F267',
      ownerStateRef: 'measurement-certificate:f267-capability-evolution-roadshow-e0-v1',
    });
    assert.deepEqual(result.binding.measurementRoleRefs.consumer, {
      ownerFeatureId: 'F267',
      ownerStateRef: 'measurement-role:f267-capability-evolution-roadshow-e0-proof-v1:consumer',
    });
    assert.deepEqual(result.binding.sourceRef, {
      ownerFeatureId: 'F311',
      ownerStateRef: 'capability-evolution-measurement-source:evolution-program-bcc336788a7df9d6075b1efb4c0a7e68',
    });
  });
  it('rejects a different owner user or missing proof without returning partial refs', async (t) => {
    const fixture = await measurementBindingGitFixture(t);
    const resolver = resolverFor(fixture);
    assert.equal(
      (
        await resolver.resolveMeasurementConstitution({
          ownerUserId: 'someone-else',
          program: fixture.projection,
          evidenceProofRef,
        })
      ).status,
      'unavailable',
    );
    assert.deepEqual(
      await resolver.resolveMeasurementConstitution({
        ownerUserId: 'operator',
        program: fixture.projection,
        evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:missing-v2' },
      }),
      {
        status: 'unavailable',
        reason:
          'published artifact is not a regular Git blob: docs/harness-feedback/decision-proofs/records/missing-v2.yaml',
      },
    );
  });
  it('rejects a superseded publication even when its historical sequence pin matches', async (t) => {
    const fixture = await measurementBindingGitFixture(t);
    fixture.manifest.program.expectedSequence += 1;
    await writeYaml(fixture.repoRoot, fixture.sourceRef, fixture.manifest);
    await fixture.commit('fixture source superseded after publication');
    const result = await resolverFor(fixture).resolveMeasurementConstitution({
      ownerUserId: 'operator',
      program: fixture.projection,
      evidenceProofRef,
    });
    assert.equal(result.status, 'unavailable', JSON.stringify(result));
    assert.match(result.reason, /published proof no longer names the current owner source/u);
    assert.deepEqual(Object.keys(result).sort(), ['reason', 'status']);
  });
});
