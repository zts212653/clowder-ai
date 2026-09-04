import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { parse } from 'yaml';

const PROGRAM_ID = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
const ROOT = resolve(import.meta.dirname, '../../..');
const INPUT_ROOT = resolve(ROOT, 'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs');
const PREFIX = 'evolution-program-ba0f4524e49cc879279164d5b272cf8c';
const SOURCE_REF = resolve(ROOT, `docs/harness-feedback/measurement-sources/capability-evolution/${PREFIX}.yaml`);
const exec = promisify(execFile);

const TARGET_REF = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};
const CONSUMER_REF = { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' };
const OBSERVER_REF = { ownerFeatureId: 'F267', ownerStateRef: 'cat:codex-sol' };
const DOMAIN_OWNER_REF = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability-owner:development-process-harness-effectiveness',
};
const CALIBRATOR_REF = { ownerFeatureId: 'F267', ownerStateRef: 'cat:kimi' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readInput(suffix) {
  return parse(await readFile(resolve(INPUT_ROOT, `${PREFIX}-${suffix}.yaml`), 'utf8'));
}

describe('F314 capability-evolution owner inputs', () => {
  it('starts treatment only when the accepted-source anchor shipped in PR #4268', async () => {
    const census = await readInput('observation-census-v1');

    assert.equal(census.window.endMs, 1788426565000);
    assert.match(census.window.selection, /accepted-source anchor PR #4268 merge/);
    assert.match(census.window.boundaryPointDisposition, /treatment-start event/);
    assert.match(census.window.boundaryPointDisposition, /not a baseline outcome/);
    assert.ok(census.candidateArtifacts.every((artifact) => artifact.disposition !== 'eligible_observation'));
  });

  it('derives both comparison arms from typed verdict freshness inside one durable-review channel', async () => {
    const [goal, procedure, census] = await Promise.all([
      readInput('goal-certificate-v1'),
      readInput('measurement-procedure-v1'),
      readInput('observation-census-v1'),
    ]);

    assert.equal(procedure.comparisonDesign.design, 'within_channel_first_verdict_freshness_contrast');
    assert.equal(procedure.comparisonDesign.effectScale, 'current_first_verdict_minus_stale_then_current');
    assert.equal(procedure.comparisonDesign.assignment, 'natural_source_movement_only');
    assert.equal(procedure.comparisonDesign.heldConstant, 'local_durable_review');
    assert.deepEqual(procedure.comparisonDesign.exactMatchKeys, [
      'project',
      'risk_route',
      'calendar_week',
      'review_channel',
    ]);
    assert.match(procedure.comparisonDesign.baselineDisposition, /optimizer-exposed context/i);
    assert.match(goal.successBoundary.join(' '), /current first verdict versus stale-then-current/i);
    assert.equal(census.referenceFrame.type, 'within_local_durable_review_first_verdict_freshness');
    assert.equal(census.referenceFrame.effectScale, 'current_first_verdict_minus_stale_then_current');
    assert.match(census.referenceFrame.channelBoundary, /external GitHub.*not controls/i);
    assert.match(procedure.comparisonDesign.noControlRule, /insufficient/i);

    const armDefinitions = [
      procedure.comparisonDesign.currentAtFirstVerdictArm,
      procedure.comparisonDesign.staleThenCurrentArm,
    ].join(' ');
    assert.match(armDefinitions, /first non-author typed local-review verdict/i);
    assert.match(armDefinitions, /acceptedRevision/i);
    assert.match(armDefinitions, /reviewedHeadSha/i);
    assert.doesNotMatch(armDefinitions, /request artifact|request carried|request lacked/i);
  });

  it('names every arm, join, and eligibility carrier and freezes the episode fact lifecycle', async () => {
    const [procedure, census] = await Promise.all([
      readInput('measurement-procedure-v1'),
      readInput('observation-census-v1'),
    ]);

    assert.match(procedure.typedCarrierContract.invariant, /must name an exact typed carrier/i);
    assert.match(procedure.typedCarrierContract.proseBoundary, /must not define an arm, join, or denominator/i);
    assert.deepEqual(
      procedure.typedCarrierContract.invariants.map((invariant) => invariant.id),
      ['INV-1', 'INV-2', 'INV-3', 'INV-4'],
    );
    assert.deepEqual(procedure.typedCarrierContract.armCarriers, [
      'StoredMessage.id',
      'StoredMessage.threadId',
      'StoredMessage.timestamp',
      'StoredMessage.catId',
      'StoredMessage.extra.localReviewVerdict.reviewSubjectRef',
      'StoredMessage.extra.localReviewVerdict.acceptedSourceRef',
      'StoredMessage.extra.localReviewVerdict.acceptedRevision',
      'StoredMessage.extra.localReviewVerdict.reviewedHeadSha',
      'StoredMessage.extra.localReviewVerdict.verdict',
    ]);

    const episode = procedure.episodeFactLifecycle.objects.find(
      (object) => object.id === 'durable_local_review_episode',
    );
    assert.ok(episode);
    assert.equal(episode.lifecycleOwner, 'F267 measurement owner');
    assert.match(episode.identity, /stable reviewSubjectRef.*acceptedSourceRef/i);
    assert.deepEqual(
      episode.transitions.map((transition) => transition.id),
      [
        'first_typed_verdict',
        'classify_current_first_verdict',
        'classify_stale_first_verdict',
        'observe_later_current_verdict',
        'complete_owner_joins',
        'invalidate_missing_or_drifted_carrier',
      ],
    );
    assert.match(
      procedure.episodeFactLifecycle.pureProjections.sourceRevisionAtVerdict,
      /git log -1.*reviewedHeadSha/i,
    );
    assert.match(procedure.episodeFactLifecycle.pureProjections.armLabel, /not stored independently/i);
    assert.deepEqual(
      procedure.episodeFactLifecycle.objects.map((object) => object.id),
      ['durable_local_review_episode', 'program_observation_join', 'frozen_measurement_cohort'],
    );
    assert.deepEqual(
      procedure.episodeFactLifecycle.adversarialScenarios.map((scenario) => scenario.id),
      [
        'crash_after_stale_first_verdict',
        'concurrent_verdict_delivery',
        'restored_or_truncated_history',
        'bypass_request_prose_or_external_review',
        'subject_identity_changes_between_rounds',
      ],
    );
    assert.deepEqual(
      procedure.episodeFactLifecycle.testMatrix.map((entry) => entry.invariant),
      ['INV-1', 'INV-2', 'INV-3', 'INV-4'],
    );
    assert.match(census.eligibility.typedCarrierRule, /prose-only evidence is insufficient/i);
  });

  it('predeclares decision boundaries, action vocabulary, and a separate time-fresh holdout', async () => {
    const [procedure, assignment] = await Promise.all([
      readInput('measurement-procedure-v1'),
      readInput('measurement-role-assignment-v1'),
    ]);

    assert.deepEqual(procedure.actionVocabulary, {
      keep: 'keep_observe',
      tune: 'fix',
      sunset: 'delete_sunset',
      insufficient: 'keep_observe',
    });
    assert.equal(procedure.decisionRules.intervalLevel, 0.95);
    assert.match(procedure.decisionRules.primaryImproved, /upper bound.*below zero/i);
    assert.match(procedure.decisionRules.guardrailWorsened, /lower bound.*above zero/i);
    assert.match(procedure.holdout.promotionHoldout, /next complete calendar-week matched block/i);
    assert.match(procedure.holdout.promotionHoldout, /excluded from the analysis cohort/i);
    assert.equal(assignment.certificateDecision.consumerFeatureId, 'F311');
    assert.equal(assignment.certificateDecision.consumerOwnerCatId, 'opus');
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
});
