import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { parse, stringify } from 'yaml';

export const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const SOURCE_ID = 'evolution-program-bcc336788a7df9d6075b1efb4c0a7e68';
const SOURCE_REVISION = '7ee1440c30770c7a0e4bd9e226349b65264904b3';
export const MANIFEST_REVISION = 'a3d4141d93015b21749e180656bfa23548b82049';
export const SOURCE_REF = `docs/harness-feedback/measurement-sources/capability-evolution/${SOURCE_ID}.yaml`;
const sourceRepoRoot = resolve(import.meta.dirname, '../../../..');

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function writeYaml(root, ref, value) {
  const path = join(root, ref);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(value));
}

export function fileSourceStore(repoRoot, verification = { status: 'verified' }, manifestRevision = MANIFEST_REVISION) {
  return {
    readOnMain: async (artifactRef) => {
      try {
        return {
          status: 'ok',
          bytes: await readFile(join(repoRoot, artifactRef)),
          manifestRevision,
        };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'missing' };
        return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
      }
    },
    verifySourceRevision: async () => verification,
  };
}

export function bindManifestToSourceArtifact(manifest, { sourceRevision, ref, bytes }) {
  const sourceSha256 = sha256(bytes);
  manifest.sourceRevision = sourceRevision;
  manifest.certificate.provenance.sourceRevision = sourceRevision;
  manifest.result.cohort.ref = ref;
  manifest.result.cohort.sha256 = sourceSha256;
  manifest.sourceArtifacts = [{ ownerFeatureId: manifest.ownerFeatureId, ref, sha256: sourceSha256 }];
  manifest.decisionProof.subject.evaluationCohortRef = ref;
  manifest.decisionProof.subject.evaluationCohortSha256 = sourceSha256;

  for (const key of ['evidenceRole', 'optimizerExposure']) {
    const proof = manifest.decisionProof[key];
    if (!proof) continue;
    proof.cohortRef = ref;
    proof.cohortSha256 = sourceSha256;
    const entry = manifest.ownerObjects.find((candidate) => candidate.ref === proof.proof.ref);
    if (!entry) throw new Error(`missing owner object for ${key}`);
    entry.artifact.cohortRef = ref;
    entry.artifact.cohortSha256 = sourceSha256;
    proof.proof.sha256 = sha256(Buffer.from(stringify(entry.artifact)));
  }

  manifest.decisionProof.subject.certificateSha256 = sha256(Buffer.from(stringify(manifest.certificate)));
  manifest.decisionProof.subject.resultSha256 = sha256(Buffer.from(stringify(manifest.result)));
  return manifest;
}

export function keepProofInsufficient(manifest) {
  for (const key of ['evidenceRole', 'consumerConsumption', 'optimizerExposure', 'promotionHoldout']) {
    delete manifest.decisionProof[key];
  }
  manifest.ownerObjects = [];
}

export function program() {
  return {
    program: {
      programId: PROGRAM_ID,
      workspaceId: 'user:operator',
      lifecycle: 'active',
      stage: 'constituting',
      sequence: 1,
      cycle: 1,
      objectRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:f311-investor-roadshow-expression' },
      claimRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-claim:${PROGRAM_ID}` },
    },
  };
}

function ownerObject(objectType, ownerFeatureId, payload) {
  return {
    kind: 'f267-measurement-decision-proof-owner-object',
    schemaVersion: 1,
    objectType,
    ownerUserId: 'operator',
    ownerFeatureId,
    ...payload,
  };
}

export async function validSourceManifest() {
  const certificate = parse(
    await readFile(join(sourceRepoRoot, 'docs/harness-feedback/certificates/f267-memory-search-quality.yaml'), 'utf8'),
  );
  const result = parse(
    await readFile(
      join(
        sourceRepoRoot,
        'docs/harness-feedback/measurement-results/f267-memory-search-quality-negative-control-v1.yaml',
      ),
      'utf8',
    ),
  );
  certificate.certificateId = 'f267-capability-evolution-roadshow-e0-v1';
  certificate.bundleId = 'f267-capability-evolution-roadshow-e0-v1';
  certificate.domainId = 'eval:capability-evolution';
  certificate.measurementTarget.id = 'F311/capability:f311-investor-roadshow-expression';
  certificate.decision = {
    consumerFeatureId: 'F311',
    consumerOwnerCatId: 'codex-sol',
    allowedActions: ['keep_observe'],
    primaryQuestion: 'Does the expression survive listener restatement without unsupported claims?',
  };
  certificate.provenance.sourceRevision = SOURCE_REVISION;
  certificate.provenance.generatedAt = '2026-09-02T16:00:00.000Z';

  const certificateRef = `docs/harness-feedback/certificates/${certificate.certificateId}.yaml`;
  result.resultId = 'f267-capability-evolution-roadshow-e0-result-v1';
  result.certificateId = certificate.certificateId;
  result.certificateRef = certificateRef;
  result.bundleId = certificate.bundleId;
  result.domainId = certificate.domainId;
  result.generatedAt = '2026-09-02T16:00:00.000Z';
  result.cohort = {
    ref: 'docs/content/drafts/ppt-huawei-live-qa-index.md',
    sha256: 'a'.repeat(64),
    window: { startMs: 100, endMs: 200 },
  };
  result.decision = {
    status: 'insufficient',
    reasons: ['candidate documents are not a measured listener cohort'],
    withdrawalConditions: ['collect a source-owner scored listener-restatement cohort'],
  };
  result.actionProposal = {
    action: 'keep_observe',
    rationale: 'No action until a real consumer cohort exists.',
  };
  const resultRef = `docs/harness-feedback/measurement-results/${result.resultId}.yaml`;

  const proofId = 'f267-capability-evolution-roadshow-e0-proof-v1';
  const ownerRoot = 'docs/harness-feedback/decision-proofs/owner-objects';
  const refs = Object.fromEntries(
    ['evidence-role', 'consumer-receipt', 'optimizer-exposure', 'holdout-cohort', 'holdout-proof', 'holdout-seal'].map(
      (name) => [name, `${ownerRoot}/${proofId}-${name}.yaml`],
    ),
  );
  const window = { startMs: 300, endMs: 400 };
  const objects = {
    'evidence-role': ownerObject('evidence_role', 'F311', {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      roles: ['discovery', 'attribution', 'validation'],
    }),
    'consumer-receipt': ownerObject('consumer_consumption', 'F311', {
      consumerFeatureId: 'F311',
      consumerOwnerCatId: 'codex-sol',
      resultId: result.resultId,
      consumedAt: '2026-09-02T16:05:00.000Z',
    }),
    'optimizer-exposure': ownerObject('optimizer_exposure', 'F311', {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      candidateSelection: 'exposed',
      rubricSelection: 'not_exposed',
    }),
    'holdout-cohort': ownerObject('promotion_holdout_cohort', 'F311', {
      cohortRef: refs['holdout-cohort'],
      window,
    }),
  };
  const objectBytes = Object.fromEntries(
    Object.entries(objects).map(([name, value]) => [name, Buffer.from(stringify(value))]),
  );
  const cohortSha256 = sha256(objectBytes['holdout-cohort']);
  objects['holdout-seal'] = ownerObject('promotion_holdout_seal', 'F311', {
    cohortRef: refs['holdout-cohort'],
    cohortSha256,
    sealedAtMs: 200,
    optimizerSelectionCutoffMs: 250,
  });
  objectBytes['holdout-seal'] = Buffer.from(stringify(objects['holdout-seal']));
  const seal = { ownerFeatureId: 'F311', ref: refs['holdout-seal'], sha256: sha256(objectBytes['holdout-seal']) };
  objects['holdout-proof'] = ownerObject('promotion_holdout', 'F311', {
    cohortRef: refs['holdout-cohort'],
    cohortSha256,
    window,
    independence: { kind: 'sealed', sealedAtMs: 200, optimizerSelectionCutoffMs: 250, seal },
    optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
  });
  objectBytes['holdout-proof'] = Buffer.from(stringify(objects['holdout-proof']));
  const ownerObjects = Object.entries(objects).map(([name, artifact]) => ({ ref: refs[name], artifact }));
  const objectRef = (name) => ({ ownerFeatureId: 'F311', ref: refs[name], sha256: sha256(objectBytes[name]) });

  const decisionProof = {
    kind: 'f267-measurement-decision-proof-candidate',
    schemaVersion: 1,
    proofId,
    generatedAt: '2026-09-02T16:00:00.000Z',
    subject: {
      certificateId: certificate.certificateId,
      certificateRef,
      certificateSha256: sha256(Buffer.from(stringify(certificate))),
      resultId: result.resultId,
      resultRef,
      resultSha256: sha256(Buffer.from(stringify(result))),
      evaluationCohortRef: result.cohort.ref,
      evaluationCohortSha256: result.cohort.sha256,
    },
    evidenceRole: {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      roles: ['discovery', 'attribution', 'validation'],
      proof: objectRef('evidence-role'),
    },
    consumerConsumption: {
      consumerFeatureId: 'F311',
      consumerOwnerCatId: 'codex-sol',
      resultId: result.resultId,
      consumedAt: '2026-09-02T16:05:00.000Z',
      receipt: objectRef('consumer-receipt'),
    },
    optimizerExposure: {
      cohortRef: result.cohort.ref,
      cohortSha256: result.cohort.sha256,
      candidateSelection: 'exposed',
      rubricSelection: 'not_exposed',
      proof: objectRef('optimizer-exposure'),
    },
    promotionHoldout: {
      cohortRef: refs['holdout-cohort'],
      cohortSha256,
      window,
      independence: { kind: 'sealed', sealedAtMs: 200, optimizerSelectionCutoffMs: 250, seal },
      optimizerExposure: { candidateSelection: 'not_exposed', rubricSelection: 'not_exposed' },
      proof: objectRef('holdout-proof'),
    },
  };
  return {
    kind: 'f267-capability-evolution-measurement-source',
    schemaVersion: 1,
    sourceId: SOURCE_ID,
    ownerUserId: 'operator',
    ownerFeatureId: 'F311',
    generatedAt: '2026-09-02T16:00:00.000Z',
    sourceRevision: SOURCE_REVISION,
    sourceArtifacts: [{ ownerFeatureId: 'F311', ref: result.cohort.ref, sha256: result.cohort.sha256 }],
    program: {
      programId: PROGRAM_ID,
      expectedSequence: 1,
      targetRef: program().program.objectRef,
      claimRef: program().program.claimRef,
    },
    roles: {
      observer: { ownerFeatureId: 'F267', ownerStateRef: 'cat:codex-sol' },
      domainOwner: { ownerFeatureId: 'F311', ownerStateRef: 'capability-owner:investor-roadshow-expression' },
      consumer: { ownerFeatureId: 'F311', ownerStateRef: 'user:operator' },
      calibrator: { ownerFeatureId: 'F267', ownerStateRef: 'cat:codex-terra' },
    },
    certificate,
    result,
    decisionProof,
    ownerObjects,
  };
}
