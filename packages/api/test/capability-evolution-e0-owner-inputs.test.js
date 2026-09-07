import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { parse } from 'yaml';

import { stableId } from '../dist/infrastructure/capability-evolution/program-service-options.js';

const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const SOURCE_MESSAGE_ID = '0001788247822187-000020-6df719f3';
const TARGET_REF = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'capability:f311-investor-roadshow-expression',
};
const CONSUMER_REF = { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' };
const OBSERVER_REF = { ownerFeatureId: 'F267', ownerStateRef: 'cat:codex-sol' };
const DOMAIN_OWNER_REF = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'capability-owner:investor-roadshow-expression',
};
const CALIBRATOR_REF = { ownerFeatureId: 'F267', ownerStateRef: 'cat:codex-terra' };
const ROOT = resolve(import.meta.dirname, '../../..');
const INPUT_ROOT = resolve(ROOT, 'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs');
const PREFIX = `evolution-program-${PROGRAM_ID.slice('evolution-program:'.length)}`;
const SOURCE_REF = resolve(ROOT, `docs/harness-feedback/measurement-sources/capability-evolution/${PREFIX}.yaml`);
const exec = promisify(execFile);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readInput(suffix) {
  return parse(await readFile(resolve(INPUT_ROOT, `${PREFIX}-${suffix}.yaml`), 'utf8'));
}

describe('F311 real E0 owner inputs', () => {
  it('replays the production Program identity from the exact operator source message', () => {
    assert.equal(stableId('evolution-program', 'user:default-user', SOURCE_MESSAGE_ID), PROGRAM_ID);
  });

  it('keeps every owner certificate and measurement input on the exact real Program', async () => {
    const [charter, goal, economic, procedure, census] = await Promise.all([
      readInput('charter-v1'),
      readInput('goal-certificate-v1'),
      readInput('economic-certificate-v1'),
      readInput('measurement-procedure-v1'),
      readInput('observation-census-v1'),
    ]);

    for (const input of [charter, goal, economic, procedure, census]) {
      assert.equal(input.programId, PROGRAM_ID);
      assert.deepEqual(input.targetRef, TARGET_REF);
    }
    assert.deepEqual(charter.consumerRef, CONSUMER_REF);
    assert.deepEqual(procedure.consumerRef, CONSUMER_REF);
    assert.deepEqual(census.consumerRef, CONSUMER_REF);
    assert.deepEqual(charter.valueOwnerRef, CONSUMER_REF);
    assert.deepEqual(goal.consumerRef, CONSUMER_REF);
    assert.deepEqual(economic.valueOwnerRef, CONSUMER_REF);
    assert.deepEqual(charter.goalCertificateRef, goal.certificateRef);
    assert.deepEqual(charter.economicCertificateRef, economic.certificateRef);
    assert.match(goal.sourceRef, /^thread_ms9gw96ssk7lm13j#/);
    assert.ok(economic.notAuthorized.includes('Touch Redis 6399.'));
  });

  it('defines all six decision-procedure components without claiming an observation', async () => {
    const procedure = await readInput('measurement-procedure-v1');

    assert.deepEqual(Object.keys(procedure.components), ['judge', 'rubric', 'classifier', 'prompt', 'model', 'code']);
    assert.match(procedure.utilityClaim, /real listener/i);
    assert.match(
      procedure.truthBoundary.join(' '),
      /not an observation, result, proof, intervention, or value verdict/i,
    );
  });

  it('freezes the current zero-sample census as insufficient keep_observe', async () => {
    const census = await readInput('observation-census-v1');

    assert.equal(census.window.boundary, 'half_open');
    assert.ok(census.window.startMs < census.window.endMs);
    assert.match(census.measurementProcedureRef, /measurement-procedure-v1\.yaml$/);
    assert.deepEqual(census.eligibleObservationRefs, []);
    assert.equal(census.measurementDisposition.status, 'insufficient');
    assert.equal(census.measurementDisposition.proposedAction, 'keep_observe');
    assert.ok(census.candidateArtifacts.every((artifact) => artifact.disposition !== 'eligible_observation'));
    assert.ok(census.measurementDisposition.withdrawalConditions.length > 0);
  });

  it('assigns all measurement occupants without granting intervention authority', async () => {
    const assignment = await readInput('measurement-role-assignment-v1');

    assert.equal(assignment.programId, PROGRAM_ID);
    assert.deepEqual(assignment.targetRef, TARGET_REF);
    assert.deepEqual(assignment.roles, {
      observer: OBSERVER_REF,
      domainOwner: DOMAIN_OWNER_REF,
      consumer: CONSUMER_REF,
      calibrator: CALIBRATOR_REF,
    });
    assert.equal(assignment.certificateDecision.consumerOwnerCatId, 'codex-sol');
    assert.match(assignment.calibratorAcceptanceRef, /^thread_mtjnb79maf8n7wr8#/);
    assert.equal(new Set(Object.values(assignment.roles).map((ref) => JSON.stringify(ref))).size, 4);
    assert.match(assignment.truthBoundary.join(' '), /does not authorize an intervention/i);
    assert.match(assignment.calibratorIndependence, /non-author/i);
  });

  it('binds the six owner inputs into a validated zero-sample F267 source manifest', async () => {
    const manifest = parse(await readFile(SOURCE_REF, 'utf8'));
    const [{ CapabilityEvolutionMeasurementSourceSchema }, { validateCapabilityEvolutionMeasurementSource }] =
      await Promise.all([
        import(
          '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source.js'
        ),
        import(
          '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-validation.js'
        ),
      ]);

    CapabilityEvolutionMeasurementSourceSchema.parse(manifest);
    validateCapabilityEvolutionMeasurementSource({
      manifest,
      ownerUserId: 'default-user',
      projection: {
        program: {
          programId: PROGRAM_ID,
          workspaceId: 'user:default-user',
          lifecycle: 'active',
          stage: 'constituting',
          sequence: 1,
          cycle: 1,
          objectRef: TARGET_REF,
          claimRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: `evolution-claim:${PROGRAM_ID}`,
          },
          valueOwnerRef: CONSUMER_REF,
        },
      },
    });

    assert.equal(manifest.sourceArtifacts.length, 6);
    for (const sourceArtifact of manifest.sourceArtifacts) {
      const { stdout } = await exec('git', ['-C', ROOT, 'show', `${manifest.sourceRevision}:${sourceArtifact.ref}`]);
      assert.equal(sha256(Buffer.from(stdout)), sourceArtifact.sha256, sourceArtifact.ref);
    }
    assert.deepEqual(manifest.roles, {
      observer: OBSERVER_REF,
      domainOwner: DOMAIN_OWNER_REF,
      consumer: CONSUMER_REF,
      calibrator: CALIBRATOR_REF,
    });
    assert.ok(manifest.result.metrics.every((metric) => metric.n === 0));
    assert.ok(manifest.result.metrics.every((metric) => metric.pointEstimate === null));
    assert.ok(manifest.result.metrics.every((metric) => metric.evidenceStatus === 'insufficient'));
    assert.equal(manifest.result.decision.status, 'insufficient');
    assert.equal(manifest.result.actionProposal.action, 'keep_observe');
    assert.deepEqual(manifest.ownerObjects, []);
    assert.deepEqual(Object.keys(manifest.decisionProof), [
      'kind',
      'schemaVersion',
      'proofId',
      'generatedAt',
      'subject',
    ]);
  });

  it('publishes an eval-repair owner binding without inventing authorization, lineage, or receipts', async () => {
    const [binding, manifest] = await Promise.all([
      readInput('eval-repair-owner-binding-v1'),
      readFile(SOURCE_REF, 'utf8').then(parse),
    ]);

    assert.equal(binding.measurementSourceRef, SOURCE_REF.slice(ROOT.length + 1));
    assert.deepEqual(binding.programRef, { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID });
    assert.deepEqual(binding.targetRef, TARGET_REF);
    assert.deepEqual(binding.valueOwnerRef, CONSUMER_REF);
    assert.deepEqual(binding.domainOwnerRef, DOMAIN_OWNER_REF);
    assert.equal(binding.ownerAuthorization.status, 'missing');
    assert.deepEqual(binding.ownerAuthorization.blockerRef, {
      ownerFeatureId: 'F311',
      ownerStateRef: `evolution-economic-certificate:${PROGRAM_ID}:v1`,
    });
    assert.deepEqual(binding.lineageBindings, []);
    assert.deepEqual(binding.interventionReceipts, []);
    assert.deepEqual(binding.freshOutcomeReceipts, []);
    assert.deepEqual(binding.decisionReceipts, []);
    assert.deepEqual(manifest.ownerObjects, []);
    assert.equal(manifest.result.decision.status, 'insufficient');
    assert.equal(manifest.result.actionProposal.action, 'keep_observe');
  });
});
