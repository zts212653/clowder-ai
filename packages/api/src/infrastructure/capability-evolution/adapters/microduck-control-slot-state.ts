import { createHash } from 'node:crypto';
import { type ExactAssetVersionRefV1, type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import { MICRODUCK_CONTROL_SUBJECT_ORDER } from './microduck-control-evaluation-schemas.js';
import type { MicroduckRollbackReceipt, MicroduckWritebackReceipt } from './microduck-owner-contract.js';
import { microduckRollbackSchema, microduckWritebackSchema } from './microduck-owner-schemas.js';
import {
  exactRef,
  isMicroduckControlPackageRef,
  isMicroduckPolicyRef,
  ownerRef,
} from './microduck-owner-validation.js';

const OWNER_FEATURE_ID = 'microduck-owner';

export interface MicroduckControlSlotVersionV1 {
  readonly artifactVersionRef: ExactAssetVersionRefV1;
  readonly configRef: OwnerTruthRefV1;
  readonly configBytes: Uint8Array;
  readonly policyVersionRef: ExactAssetVersionRefV1;
  readonly policySha256: string;
  readonly runnerRef: OwnerTruthRefV1;
  readonly evaluationEnvRef: OwnerTruthRefV1;
  readonly evaluationReceiptRef: OwnerTruthRefV1;
  readonly verificationReceiptRef: OwnerTruthRefV1;
}

export interface StoredVersionV1 extends Omit<MicroduckControlSlotVersionV1, 'configBytes'> {
  readonly configBase64: string;
}

export type StoredReceipt = MicroduckWritebackReceipt | MicroduckRollbackReceipt;

export interface StoredOperationV1 {
  readonly fingerprint: `sha256:${string}`;
  readonly receipt: StoredReceipt;
}

export interface ControlSlotSnapshotV1 {
  readonly schemaVersion: 1;
  readonly currentVersion: string;
  readonly currentOperationClientMessageId?: string;
  readonly currentDeploymentReceiptRef?: OwnerTruthRefV1;
  readonly versions: Readonly<Record<string, StoredVersionV1>>;
  readonly operations: Readonly<Record<string, StoredOperationV1>>;
}

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export const canonicalJson = (value: unknown): string => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
export const fingerprint = (value: unknown): `sha256:${string}` => `sha256:${sha256(canonicalJson(value))}`;

export function targetRef(version: string): ExactAssetVersionRefV1 {
  return {
    ownerFeatureId: OWNER_FEATURE_ID,
    ownerStateRef: 'simulator:walking',
    version,
    assetKind: 'simulator-control-slot',
    assetId: 'walking',
  };
}

export function receiptRef(prefix: 'deploy' | 'rollback-receipt', digest: string): OwnerTruthRefV1 {
  return ownerRef({
    ownerFeatureId: OWNER_FEATURE_ID,
    ownerStateRef: `${prefix}:sha256:${digest}`,
    version: digest,
  });
}

export function exactSame(left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean {
  return (
    left.ownerFeatureId === right.ownerFeatureId &&
    left.ownerStateRef === right.ownerStateRef &&
    left.version === right.version &&
    left.assetKind === right.assetKind &&
    left.assetId === right.assetId
  );
}

function hashRef(value: OwnerTruthRefV1, prefix: string): string | undefined {
  if (value.ownerFeatureId !== OWNER_FEATURE_ID) return undefined;
  const digest = new RegExp(`^${prefix}:sha256:([a-f0-9]{64})$`, 'u').exec(value.ownerStateRef)?.[1];
  return digest && value.version === digest ? digest : undefined;
}

export function normalizeVersion(input: MicroduckControlSlotVersionV1): MicroduckControlSlotVersionV1 {
  const artifactVersionRef = exactRef(input.artifactVersionRef);
  const policyVersionRef = exactRef(input.policyVersionRef);
  const configRef = ownerRef(input.configRef);
  const runnerRef = ownerRef(input.runnerRef);
  const evaluationEnvRef = ownerRef(input.evaluationEnvRef);
  const evaluationReceiptRef = ownerRef(input.evaluationReceiptRef);
  const verificationReceiptRef = ownerRef(input.verificationReceiptRef);
  const configBytes = new Uint8Array(input.configBytes);
  const configSha256 = hashRef(configRef, 'control-config');
  if (
    !isMicroduckControlPackageRef(artifactVersionRef) ||
    !MICRODUCK_CONTROL_SUBJECT_ORDER.includes(
      artifactVersionRef.assetId as (typeof MICRODUCK_CONTROL_SUBJECT_ORDER)[number],
    ) ||
    !isMicroduckPolicyRef(policyVersionRef, 'space') ||
    !/^[a-f0-9]{64}$/u.test(input.policySha256) ||
    !configSha256 ||
    !hashRef(runnerRef, 'runner') ||
    !hashRef(evaluationEnvRef, 'evaluation-env') ||
    !hashRef(evaluationReceiptRef, 'evaluation') ||
    !hashRef(verificationReceiptRef, 'verification') ||
    sha256(configBytes) !== configSha256
  ) {
    throw new Error('Invalid Microduck control slot version');
  }
  const config: unknown = JSON.parse(Buffer.from(configBytes).toString('utf8'));
  if (
    !isRecord(config) ||
    Object.keys(config).sort().join(',') !== 'actionScale,schemaVersion' ||
    config.schemaVersion !== 1 ||
    typeof config.actionScale !== 'number' ||
    !Number.isFinite(config.actionScale) ||
    config.actionScale <= 0
  ) {
    throw new Error('Invalid Microduck control config bytes');
  }
  const packageVersion = sha256(
    canonicalJson({
      artifactKind: 'microduck-control-package',
      configRef: configRef.ownerStateRef,
      evaluationEnvRef: evaluationEnvRef.ownerStateRef,
      policyRef: policyVersionRef.ownerStateRef,
      policySha256: input.policySha256,
      runnerRef: runnerRef.ownerStateRef,
      schemaVersion: 1,
    }),
  );
  if (packageVersion !== artifactVersionRef.version) throw new Error('Microduck control package hash mismatch');
  return {
    artifactVersionRef,
    configRef,
    configBytes,
    policyVersionRef,
    policySha256: input.policySha256,
    runnerRef,
    evaluationEnvRef,
    evaluationReceiptRef,
    verificationReceiptRef,
  };
}

export function storeVersion(version: MicroduckControlSlotVersionV1): StoredVersionV1 {
  return {
    artifactVersionRef: version.artifactVersionRef,
    configRef: version.configRef,
    configBase64: Buffer.from(version.configBytes).toString('base64'),
    policyVersionRef: version.policyVersionRef,
    policySha256: version.policySha256,
    runnerRef: version.runnerRef,
    evaluationEnvRef: version.evaluationEnvRef,
    evaluationReceiptRef: version.evaluationReceiptRef,
    verificationReceiptRef: version.verificationReceiptRef,
  };
}

export function loadVersion(value: unknown): MicroduckControlSlotVersionV1 {
  if (!isRecord(value) || typeof value.configBase64 !== 'string') {
    throw new Error('Invalid Microduck control slot stored version');
  }
  return normalizeVersion({
    artifactVersionRef: value.artifactVersionRef as ExactAssetVersionRefV1,
    configRef: value.configRef as OwnerTruthRefV1,
    configBytes: Buffer.from(value.configBase64, 'base64'),
    policyVersionRef: value.policyVersionRef as ExactAssetVersionRefV1,
    policySha256: String(value.policySha256),
    runnerRef: value.runnerRef as OwnerTruthRefV1,
    evaluationEnvRef: value.evaluationEnvRef as OwnerTruthRefV1,
    evaluationReceiptRef: value.evaluationReceiptRef as OwnerTruthRefV1,
    verificationReceiptRef: value.verificationReceiptRef as OwnerTruthRefV1,
  });
}

function parseCurrentOperationClientMessageId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !validClientMessageId(value)) {
    throw new Error('Invalid Microduck slot current operation id');
  }
  return value;
}

function currentOperationMatchesSnapshot(input: {
  currentOperationClientMessageId?: string;
  currentDeploymentReceiptRef?: OwnerTruthRefV1;
  currentVersion: string;
  versions: Readonly<Record<string, StoredVersionV1>>;
  operations: Readonly<Record<string, StoredOperationV1>>;
}): boolean {
  if (input.currentOperationClientMessageId === undefined) return Object.keys(input.operations).length === 0;
  const operation = input.operations[input.currentOperationClientMessageId];
  if (!operation) return false;
  const receipt = operation.receipt;
  return receipt.status === 'deployed'
    ? Boolean(
        input.currentDeploymentReceiptRef &&
          refIdentity(receipt.writebackReceiptRef) === refIdentity(input.currentDeploymentReceiptRef) &&
          exactSame(receipt.deployedVersionRef, targetRef(input.currentVersion)),
      )
    : !input.currentDeploymentReceiptRef &&
        exactSame(receipt.restoredVersionRef, loadVersion(input.versions[input.currentVersion]).artifactVersionRef);
}

export function parseSnapshot(raw: string): ControlSlotSnapshotV1 {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.currentVersion !== 'string' ||
    !isRecord(parsed.versions) ||
    !isRecord(parsed.operations)
  ) {
    throw new Error('Invalid Microduck control slot snapshot');
  }
  const currentVersion = parsed.currentVersion;
  const versions = Object.fromEntries(
    Object.entries(parsed.versions).map(([key, value]) => {
      const normalized = loadVersion(value);
      if (normalized.artifactVersionRef.version !== key) throw new Error('Microduck slot version key mismatch');
      return [key, storeVersion(normalized)];
    }),
  );
  if (!(currentVersion in versions)) throw new Error('Microduck slot current version missing');
  const operations = Object.fromEntries(
    Object.entries(parsed.operations).map(([key, value]) => {
      if (!validClientMessageId(key) || !isRecord(value) || !/^sha256:[a-f0-9]{64}$/u.test(String(value.fingerprint))) {
        throw new Error('Invalid Microduck slot operation');
      }
      return [key, { fingerprint: value.fingerprint as `sha256:${string}`, receipt: parseReceipt(value.receipt) }];
    }),
  );
  const currentDeploymentReceiptRef =
    parsed.currentDeploymentReceiptRef === undefined
      ? undefined
      : ownerRef(parsed.currentDeploymentReceiptRef as OwnerTruthRefV1);
  const currentOperationClientMessageId = parseCurrentOperationClientMessageId(parsed.currentOperationClientMessageId);
  if (
    currentDeploymentReceiptRef &&
    (!hashRef(currentDeploymentReceiptRef, 'deploy') ||
      !Object.values(operations).some(
        ({ receipt }) =>
          receipt.status === 'deployed' &&
          refIdentity(receipt.writebackReceiptRef) === refIdentity(currentDeploymentReceiptRef) &&
          exactSame(receipt.deployedVersionRef, targetRef(currentVersion)),
      ))
  ) {
    throw new Error('Microduck slot current deployment receipt mismatch');
  }
  if (
    !currentOperationMatchesSnapshot({
      currentOperationClientMessageId,
      currentDeploymentReceiptRef,
      currentVersion,
      versions,
      operations,
    })
  ) {
    throw new Error('Microduck slot current operation state mismatch');
  }
  return {
    schemaVersion: 1,
    currentVersion,
    versions,
    operations,
    ...(currentOperationClientMessageId !== undefined ? { currentOperationClientMessageId } : {}),
    ...(currentDeploymentReceiptRef ? { currentDeploymentReceiptRef } : {}),
  };
}

function parseReceipt(value: unknown): StoredReceipt {
  const deployed = microduckWritebackSchema.safeParse(value);
  return deployed.success ? deployed.data : microduckRollbackSchema.parse(value);
}

export function validClientMessageId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
