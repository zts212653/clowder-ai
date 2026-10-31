import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'yaml';

import type {
  MeasurementConstitutionResolution,
  MeasurementConstitutionResolver,
} from '../../../capability-evolution/program-evaluation-contract.js';
import { digest } from '../measurement-decision-proof-files.js';
import { MeasurementDecisionProofOwnerObjectSchema } from '../measurement-decision-proof-owner-object.js';
import { MeasurementDecisionProofRecordSchema } from '../measurement-decision-proof-schema.js';
import { capabilityEvolutionMeasurementRoleRefs } from './capability-evolution-measurement-publication-replay.js';
import {
  CapabilityEvolutionMeasurementRoleBindingSchema,
  type CapabilityEvolutionMeasurementSource,
  CapabilityEvolutionMeasurementSourceSchema,
} from './capability-evolution-measurement-source.js';
import { verifyCapabilityEvolutionMeasurementSourceFromGit } from './capability-evolution-measurement-source-store.js';
import {
  buildCapabilityEvolutionMeasurementRoleArtifacts,
  capabilityEvolutionMeasurementSourceArtifactRef,
  capabilityEvolutionMeasurementSourceRef,
  validateCapabilityEvolutionMeasurementSource,
} from './capability-evolution-measurement-source-validation.js';

const PROOF_RECORD_ROOT = 'docs/harness-feedback/decision-proofs/records';
const CERTIFICATE_ROOT = 'docs/harness-feedback/certificates';
const RESULT_ROOT = 'docs/harness-feedback/measurement-results';
const ROLE_ROOT = 'docs/harness-feedback/measurement-roles';
const OWNER_OBJECT_ROOT = 'docs/harness-feedback/decision-proofs/owner-objects';
const SOURCE_ROOT = 'docs/harness-feedback/measurement-sources/capability-evolution';
const FULL_REVISION = /^[a-f0-9]{40}$/;
const PROOF_REF = /^measurement-proof:([a-z0-9][a-z0-9-]{0,127})$/;

const git = (
  repoRoot: string,
  args: string[],
  options: { encoding?: BufferEncoding | 'buffer'; maxBuffer?: number; timeout?: number } = {},
) =>
  new Promise<string | Buffer>((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      {
        encoding: options.encoding === 'buffer' ? 'buffer' : (options.encoding ?? 'utf8'),
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        timeout: options.timeout ?? 10_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : stderr.trim()));
        else resolve(stdout);
      },
    );
  });

function safePath(ref: string, requiredRoot: string): boolean {
  return (
    ref.startsWith(`${requiredRoot}/`) &&
    !ref.includes('..') &&
    !ref.includes('\\') &&
    !ref.includes('\0') &&
    !ref.startsWith('/')
  );
}

async function regularBlob(repoRoot: string, revision: string, ref: string, requiredRoot: string): Promise<Buffer> {
  if (!FULL_REVISION.test(revision) || !safePath(ref, requiredRoot)) {
    throw new Error(`unsafe publication ref: ${ref}`);
  }
  const rawEntry = await git(repoRoot, ['ls-tree', '-z', revision, '--', ref], { encoding: 'buffer' });
  const entry = (rawEntry as Buffer).toString('utf8').replace(/\0$/u, '');
  const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/u.exec(entry);
  if (!match || match[2] !== ref) throw new Error(`published artifact is not a regular Git blob: ${ref}`);
  return (await git(repoRoot, ['show', `${revision}:${ref}`], { encoding: 'buffer' })) as Buffer;
}

async function ancestor(repoRoot: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(repoRoot, ['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false;
  }
}

type ResolveInput = Parameters<MeasurementConstitutionResolver['resolveMeasurementConstitution']>[0];
type ResolverOptions = { repoRoot: string; mainRef: string; fetchMain: boolean };

interface PublicationContext {
  manifest: CapabilityEvolutionMeasurementSource;
  sourceArtifactRef: string;
  sourceRef: ReturnType<typeof capabilityEvolutionMeasurementSourceRef>;
  sourceSha256: string;
}

async function readPublicationContext(
  input: ResolveInput,
  options: ResolverOptions,
  mainRevision: string,
  proofId: string,
): Promise<PublicationContext> {
  const proofPath = `${PROOF_RECORD_ROOT}/${proofId}.yaml`;
  const proofRecord = MeasurementDecisionProofRecordSchema.parse(
    parse((await regularBlob(options.repoRoot, mainRevision, proofPath, PROOF_RECORD_ROOT)).toString('utf8')),
  );
  const attestation = proofRecord.sourceAttestations?.[0];
  const manifestRevision = attestation?.manifestRevision;
  if (
    proofRecord.ownerUserId !== input.ownerUserId ||
    proofRecord.candidate.proofId !== proofId ||
    proofRecord.sourceAttestations?.length !== 1 ||
    !attestation ||
    !manifestRevision ||
    !FULL_REVISION.test(manifestRevision) ||
    !(await ancestor(options.repoRoot, manifestRevision, mainRevision))
  ) {
    throw new Error('published proof identity mismatch');
  }

  const sourceArtifactRef = capabilityEvolutionMeasurementSourceArtifactRef(input.program.program.programId);
  const sourceRef = capabilityEvolutionMeasurementSourceRef(input.program);
  if (
    attestation.artifactRef !== sourceArtifactRef ||
    attestation.ownerFeatureId !== sourceRef.ownerFeatureId ||
    attestation.ownerStateRef !== sourceRef.ownerStateRef
  ) {
    throw new Error('published source attestation mismatch');
  }
  const currentSourceBytes = await regularBlob(options.repoRoot, mainRevision, sourceArtifactRef, SOURCE_ROOT);
  if (digest(currentSourceBytes) !== attestation.sha256) {
    throw new Error('published proof no longer names the current owner source');
  }
  const sourceBytes = await regularBlob(options.repoRoot, manifestRevision, sourceArtifactRef, SOURCE_ROOT);
  if (digest(sourceBytes) !== attestation.sha256) throw new Error('published source manifest hash mismatch');
  const rawManifest = parse(sourceBytes.toString('utf8'));
  CapabilityEvolutionMeasurementSourceSchema.parse(rawManifest);
  // Hashes name the owner's exact YAML mapping. Zod validates a transformed clone (several
  // bounded strings trim), so—as in the issuer—keep the raw parsed object for all identity work.
  const manifest = rawManifest as CapabilityEvolutionMeasurementSource;
  validateCapabilityEvolutionMeasurementSource({
    manifest,
    projection: input.program,
    ownerUserId: input.ownerUserId,
  });
  const sourceVerification = await verifyCapabilityEvolutionMeasurementSourceFromGit({
    repoRoot: options.repoRoot,
    manifest,
    manifestRevision,
    trustedMainRef: mainRevision,
  });
  if (sourceVerification.status !== 'verified') throw new Error(sourceVerification.detail);
  if (!isDeepStrictEqual(proofRecord.candidate, manifest.decisionProof)) {
    throw new Error('published proof payload mismatch');
  }
  return { manifest, sourceArtifactRef, sourceRef, sourceSha256: attestation.sha256 };
}

async function verifyPublishedOwnerObjects(
  options: ResolverOptions,
  mainRevision: string,
  manifest: CapabilityEvolutionMeasurementSource,
): Promise<void> {
  for (const ownerObject of manifest.ownerObjects) {
    const bytes = await regularBlob(options.repoRoot, mainRevision, ownerObject.ref, OWNER_OBJECT_ROOT);
    const parsed = MeasurementDecisionProofOwnerObjectSchema.parse(parse(bytes.toString('utf8')));
    if (
      digest(bytes) !== digest(Buffer.from(stringify(ownerObject.artifact))) ||
      !isDeepStrictEqual(parsed, ownerObject.artifact)
    ) {
      throw new Error(`published proof object mismatch: ${ownerObject.ref}`);
    }
  }
}

async function verifyPublishedSubject(
  options: ResolverOptions,
  mainRevision: string,
  manifest: CapabilityEvolutionMeasurementSource,
): Promise<void> {
  const certificateBytes = await regularBlob(
    options.repoRoot,
    mainRevision,
    manifest.decisionProof.subject.certificateRef,
    CERTIFICATE_ROOT,
  );
  const resultBytes = await regularBlob(
    options.repoRoot,
    mainRevision,
    manifest.decisionProof.subject.resultRef,
    RESULT_ROOT,
  );
  if (
    digest(certificateBytes) !== manifest.decisionProof.subject.certificateSha256 ||
    digest(resultBytes) !== manifest.decisionProof.subject.resultSha256 ||
    !isDeepStrictEqual(parse(certificateBytes.toString('utf8')), manifest.certificate) ||
    !isDeepStrictEqual(parse(resultBytes.toString('utf8')), manifest.result)
  ) {
    throw new Error('published certificate or result mismatch');
  }
}

async function verifiedPublishedRoles(
  options: ResolverOptions,
  mainRevision: string,
  proofId: string,
  context: PublicationContext,
) {
  const roles = buildCapabilityEvolutionMeasurementRoleArtifacts({
    manifest: context.manifest,
    sourceRef: context.sourceRef,
    sourceArtifactRef: context.sourceArtifactRef,
    sourceSha256: context.sourceSha256,
  });
  for (const role of roles) {
    const ref = `${ROLE_ROOT}/${proofId}/${role.persistedName}.yaml`;
    const bytes = await regularBlob(options.repoRoot, mainRevision, ref, ROLE_ROOT);
    const parsed = CapabilityEvolutionMeasurementRoleBindingSchema.parse(parse(bytes.toString('utf8')));
    if (digest(bytes) !== digest(Buffer.from(stringify(role.artifact))) || !isDeepStrictEqual(parsed, role.artifact)) {
      throw new Error(`published role artifact mismatch: ${role.name}`);
    }
  }
  return roles;
}

async function resolveBinding(
  input: ResolveInput,
  options: ResolverOptions,
): Promise<MeasurementConstitutionResolution> {
  const proofId =
    input.evidenceProofRef.ownerFeatureId === 'F267'
      ? PROOF_REF.exec(input.evidenceProofRef.ownerStateRef)?.[1]
      : undefined;
  if (!proofId) return { status: 'unavailable', reason: 'invalid F267 decision proof ref' };
  try {
    if (options.fetchMain) {
      await git(options.repoRoot, ['fetch', 'origin', 'main'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    }
    const mainRevision = String(
      await git(options.repoRoot, ['rev-parse', '--verify', `${options.mainRef}^{commit}`]),
    ).trim();
    const context = await readPublicationContext(input, options, mainRevision, proofId);
    await verifyPublishedOwnerObjects(options, mainRevision, context.manifest);
    await verifyPublishedSubject(options, mainRevision, context.manifest);
    const roles = await verifiedPublishedRoles(options, mainRevision, proofId, context);

    return {
      status: 'ready',
      binding: {
        sourceRef: context.sourceRef,
        measurementCertificateRef: {
          ownerFeatureId: 'F267',
          ownerStateRef: `measurement-certificate:${context.manifest.certificate.certificateId}`,
        },
        measurementRoleRefs: capabilityEvolutionMeasurementRoleRefs(proofId, roles),
      },
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error && error.message ? error.message : 'trusted-main publication unavailable',
    };
  }
}

export function createGitCapabilityEvolutionMeasurementBindingResolver(options: {
  repoRoot: string;
  mainRef?: string;
  fetchMain?: boolean;
}): MeasurementConstitutionResolver {
  const resolved = {
    repoRoot: options.repoRoot,
    mainRef: options.mainRef ?? 'origin/main',
    fetchMain: options.fetchMain ?? options.mainRef === undefined,
  };
  return {
    resolveMeasurementConstitution: (input) => resolveBinding(input, resolved),
  };
}
