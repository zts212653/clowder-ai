import {
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ExactAssetVersionRefV1 } from '../change/program-lineage.js';
import {
  MICRODUCK_OWNER_FEATURE_ID,
  type MicroduckBlocked,
  type MicroduckProgramScope,
  type MicroduckVerification,
} from './microduck-owner-contract.js';
import { microduckBlockedSchema } from './microduck-owner-schemas.js';

export const blocked = (
  code: MicroduckBlocked['code'],
  extra: Pick<MicroduckBlocked, 'blockerRef' | 'recoveryRef'> = {},
): MicroduckBlocked => ({ status: 'blocked', code, ...extra });

export const exactRef = (value: ExactAssetVersionRefV1): ExactAssetVersionRefV1 =>
  exactAssetVersionRefV1Schema.parse(value) as ExactAssetVersionRefV1;

export const ownerRef = (value: OwnerTruthRefV1): OwnerTruthRefV1 => ownerTruthRefV1Schema.parse(value);
export const sameRef = (left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean =>
  refIdentity(left) === refIdentity(right);
export const validSha256 = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);
export const sameAddress = (left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean =>
  left.ownerFeatureId === right.ownerFeatureId && left.ownerStateRef === right.ownerStateRef;
export const sameAssetSurface = (left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean =>
  left.ownerFeatureId === right.ownerFeatureId && left.assetKind === right.assetKind && left.assetId === right.assetId;
export const microduckScope = (input: MicroduckProgramScope): boolean =>
  input.objectRef.ownerFeatureId === MICRODUCK_OWNER_FEATURE_ID &&
  input.objectRef.ownerStateRef.startsWith('simulator:') &&
  typeof input.objectRef.version === 'string' &&
  /^[a-f0-9]{40}$/u.test(input.objectRef.version);

const HASH_REF = /^[a-z][a-z0-9-]*:sha256:[a-f0-9]{64}$/u;
const HF_POLICY_REFS = {
  either: /^hf-(?:model|space):[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@([a-f0-9]{40})#\S+\.onnx$/u,
  model: /^hf-model:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@([a-f0-9]{40})#\S+\.onnx$/u,
  space: /^hf-space:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@([a-f0-9]{40})#\S+\.onnx$/u,
} as const;

export const isMicroduckHashRef = (value: OwnerTruthRefV1, prefix: string): boolean =>
  value.ownerFeatureId === MICRODUCK_OWNER_FEATURE_ID &&
  value.ownerStateRef.startsWith(`${prefix}:sha256:`) &&
  HASH_REF.test(value.ownerStateRef);

export const isMicroduckPolicyRef = (
  value: ExactAssetVersionRefV1,
  namespace: keyof typeof HF_POLICY_REFS = 'either',
): boolean => {
  if (value.ownerFeatureId !== MICRODUCK_OWNER_FEATURE_ID) return false;
  const matched = HF_POLICY_REFS[namespace].exec(value.ownerStateRef);
  return matched?.[1] === value.version;
};

export const isMicroduckArtifactRef = (
  value: OwnerTruthRefV1,
  extension: 'onnx' | 'pt',
  namespace: 'either' | 'model' | 'space' = 'either',
): boolean =>
  value.ownerFeatureId === MICRODUCK_OWNER_FEATURE_ID &&
  new RegExp(
    `^hf-${namespace === 'either' ? '(?:model|space)' : namespace}:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[a-f0-9]{40}#\\S+\\.${extension}$`,
    'u',
  ).test(value.ownerStateRef);

export const isMicroduckTargetRef = (value: ExactAssetVersionRefV1): boolean =>
  value.ownerFeatureId === MICRODUCK_OWNER_FEATURE_ID &&
  value.ownerStateRef.startsWith('simulator:') &&
  /^[a-f0-9]{40}$/u.test(value.version);

export const isMicroduckJobRef = (value: OwnerTruthRefV1): boolean =>
  value.ownerFeatureId === MICRODUCK_OWNER_FEATURE_ID &&
  /^hf-job:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(value.ownerStateRef);

export function ownerBlock(value: MicroduckBlocked, fallback: MicroduckBlocked['code']): MicroduckBlocked {
  return blocked(value.code ?? fallback, {
    ...(value.blockerRef ? { blockerRef: ownerRef(value.blockerRef) } : {}),
    ...(value.recoveryRef ? { recoveryRef: ownerRef(value.recoveryRef) } : {}),
  });
}

export function parsedOwnerResponse<T extends { status: string }>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: MicroduckBlocked['code'],
): T | MicroduckBlocked {
  const parsed = z.union([schema, microduckBlockedSchema]).safeParse(value);
  if (!parsed.success) return blocked(fallback);
  return parsed.data.status === 'blocked' ? ownerBlock(parsed.data as MicroduckBlocked, fallback) : (parsed.data as T);
}

export function verificationGate(
  receipt: MicroduckVerification,
  candidateVersionRef: ExactAssetVersionRefV1,
  expectedArtifactSha256?: string,
): MicroduckVerification | MicroduckBlocked {
  if (!sameRef(exactRef(receipt.candidateVersionRef), exactRef(candidateVersionRef))) return blocked('target_drift');
  if (!isMicroduckPolicyRef(receipt.candidateVersionRef)) return blocked('target_drift');
  if (
    !isMicroduckHashRef(receipt.evaluationReceiptRef, 'evaluation') ||
    !isMicroduckHashRef(receipt.verificationReceiptRef, 'verification')
  ) {
    return blocked('verification_missing');
  }
  if (!receipt.publicEvaluationComplete || !receipt.holdoutEvaluationComplete) return blocked('holdout_incomplete');
  if (
    !receipt.holdoutSealed ||
    receipt.holdoutOptimizerExposed ||
    !isMicroduckHashRef(receipt.holdoutSealedProofRef, 'evaluation-proof') ||
    !isMicroduckHashRef(receipt.optimizerExposureProofRef, 'exposure-proof')
  ) {
    return blocked('holdout_leakage');
  }
  if (!receipt.singleVariable) return blocked('multiple_variables');
  if (
    !validSha256(receipt.evaluatedArtifactSha256) ||
    (expectedArtifactSha256 !== undefined && receipt.evaluatedArtifactSha256 !== expectedArtifactSha256)
  ) {
    return blocked('artifact_hash_mismatch');
  }
  return {
    ...receipt,
    evaluationReceiptRef: ownerRef(receipt.evaluationReceiptRef),
    verificationReceiptRef: ownerRef(receipt.verificationReceiptRef),
    holdoutSealedProofRef: ownerRef(receipt.holdoutSealedProofRef),
    optimizerExposureProofRef: ownerRef(receipt.optimizerExposureProofRef),
    candidateVersionRef: exactRef(receipt.candidateVersionRef),
  };
}
