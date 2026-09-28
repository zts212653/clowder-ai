import {
  type ExactAssetVersionRefV1,
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { canonicalFootballJson, footballSha256, MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID } from './package.js';

const timestampSchema = z.string().datetime({ offset: false });
const finite = z.number().finite();

const packageRefSchema = exactAssetVersionRefV1Schema.superRefine((value, context) => {
  const matched = /^control-package:sha256:([a-f0-9]{64})$/u.exec(value.ownerStateRef);
  if (
    value.ownerFeatureId !== 'microduck-owner' ||
    value.assetKind !== 'control-package' ||
    value.assetId !== MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID ||
    !matched ||
    matched?.[1] !== value.version
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid football package ref' });
  }
});

function ownerHashRefSchema(prefix: string) {
  return ownerTruthRefV1Schema.superRefine((value, context) => {
    const matched = new RegExp(`^${prefix}:sha256:([a-f0-9]{64})$`, 'u').exec(value.ownerStateRef);
    if (value.ownerFeatureId !== 'microduck-owner' || !matched || matched[1] !== value.version) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid ${prefix} ref` });
    }
  });
}

const loadedRuntimeRefSchema = ownerHashRefSchema('loaded-runtime');
const runtimeAbiRefSchema = ownerHashRefSchema('runtime-abi');
const loadEvidenceRefSchema = ownerHashRefSchema('load-evidence');
const operationRefSchema = ownerHashRefSchema('execution-operation');
const captureRefSchema = ownerHashRefSchema('capture');
const attemptRefSchema = ownerHashRefSchema('execution-attempt');

export const microduckFootballInvocationSchema = z
  .object({
    targetDirectionXY: z
      .tuple([finite, finite])
      .refine(([x, y]) => Math.hypot(x, y) > 0, 'target direction must be nonzero'),
    kickFoot: z.enum(['left', 'right']),
    activationDelaySeconds: finite.nonnegative(),
    scenarioRef: ownerHashRefSchema('scenario'),
  })
  .strict();

export const microduckFootballLoadedRuntimeSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('loaded'),
    packageRef: packageRefSchema,
    runtimeAbiRef: runtimeAbiRefSchema,
    loadEvidenceRef: loadEvidenceRefSchema,
    loadedAt: timestampSchema,
    loadedRuntimeRef: loadedRuntimeRefSchema,
  })
  .strict();

export const microduckFootballRawAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('recorded'),
    claim: z.literal('raw_execution_only'),
    measurementRef: z.null(),
    packageRef: packageRefSchema,
    loadedRuntimeRef: loadedRuntimeRefSchema,
    operationRef: operationRefSchema,
    invocation: microduckFootballInvocationSchema,
    captureRef: captureRefSchema,
    recordedAt: timestampSchema,
    attemptRef: attemptRefSchema,
  })
  .strict();

export type MicroduckFootballInvocationV1 = z.infer<typeof microduckFootballInvocationSchema>;
export type MicroduckFootballLoadedRuntimeV1 = z.infer<typeof microduckFootballLoadedRuntimeSchema>;
export type MicroduckFootballRawAttemptV1 = z.infer<typeof microduckFootballRawAttemptSchema>;

export interface MicroduckFootballIntegrityExpectation {
  readonly packageRef: ExactAssetVersionRefV1;
  readonly runtimeAbiRef: OwnerTruthRefV1;
}

interface LoadedRuntimeIdentityInput {
  readonly packageRef: ExactAssetVersionRefV1;
  readonly runtimeAbiRef: OwnerTruthRefV1;
  readonly loadEvidenceRef: OwnerTruthRefV1;
  readonly loadedAt: string;
}

interface RawAttemptIdentityInput {
  readonly packageRef: ExactAssetVersionRefV1;
  readonly loadedRuntimeRef: OwnerTruthRefV1;
  readonly operationRef: OwnerTruthRefV1;
  readonly invocation: MicroduckFootballInvocationV1;
  readonly captureRef: OwnerTruthRefV1;
  readonly recordedAt: string;
}

function hashRef(prefix: string, body: unknown): OwnerTruthRefV1 {
  const digest = footballSha256(canonicalFootballJson(body));
  return {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: `${prefix}:sha256:${digest}`,
    version: digest,
  };
}

const sameRef = (left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean =>
  left.ownerFeatureId === right.ownerFeatureId &&
  left.ownerStateRef === right.ownerStateRef &&
  left.version === right.version;

const samePackageRef = (left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean =>
  sameRef(left, right) && left.assetKind === right.assetKind && left.assetId === right.assetId;

function loadedRuntimeBody(input: LoadedRuntimeIdentityInput): unknown {
  return {
    schemaVersion: 1,
    status: 'loaded',
    packageRef: input.packageRef,
    runtimeAbiRef: input.runtimeAbiRef,
    loadEvidenceRef: input.loadEvidenceRef,
    loadedAt: input.loadedAt,
  };
}

function rawAttemptBody(input: RawAttemptIdentityInput): unknown {
  return {
    schemaVersion: 1,
    status: 'recorded',
    claim: 'raw_execution_only',
    measurementRef: null,
    packageRef: input.packageRef,
    loadedRuntimeRef: input.loadedRuntimeRef,
    operationRef: input.operationRef,
    invocation: input.invocation,
    captureRef: input.captureRef,
    recordedAt: input.recordedAt,
  };
}

/** Hash helper for the trusted runtime producer; this function does not perform or claim a load. */
export const createMicroduckFootballLoadedRuntimeRef = (input: LoadedRuntimeIdentityInput): OwnerTruthRefV1 =>
  hashRef('loaded-runtime', loadedRuntimeBody(input));

/** Hash helper for a capture producer; the resulting receipt remains raw and has no success semantics. */
export const createMicroduckFootballRawAttemptRef = (input: RawAttemptIdentityInput): OwnerTruthRefV1 =>
  hashRef('execution-attempt', rawAttemptBody(input));

export function validateMicroduckFootballLoadedRuntime(
  value: unknown,
  expectedIntegrity: MicroduckFootballIntegrityExpectation,
): MicroduckFootballLoadedRuntimeV1 | undefined {
  const parsed = microduckFootballLoadedRuntimeSchema.safeParse(value);
  if (
    !parsed.success ||
    !samePackageRef(parsed.data.packageRef, expectedIntegrity.packageRef) ||
    !sameRef(parsed.data.runtimeAbiRef, expectedIntegrity.runtimeAbiRef)
  ) {
    return undefined;
  }
  const expected = createMicroduckFootballLoadedRuntimeRef(parsed.data);
  return sameRef(expected, parsed.data.loadedRuntimeRef) ? parsed.data : undefined;
}

export function validateMicroduckFootballRawAttempt(
  value: unknown,
  loadedRuntime: MicroduckFootballLoadedRuntimeV1,
  expectedIntegrity: MicroduckFootballIntegrityExpectation,
): MicroduckFootballRawAttemptV1 | undefined {
  const trustedLoad = validateMicroduckFootballLoadedRuntime(loadedRuntime, expectedIntegrity);
  const parsed = microduckFootballRawAttemptSchema.safeParse(value);
  if (
    !trustedLoad ||
    !parsed.success ||
    !samePackageRef(parsed.data.packageRef, trustedLoad.packageRef) ||
    !sameRef(parsed.data.loadedRuntimeRef, trustedLoad.loadedRuntimeRef)
  ) {
    return undefined;
  }
  const expected = createMicroduckFootballRawAttemptRef(parsed.data);
  return sameRef(expected, parsed.data.attemptRef) ? parsed.data : undefined;
}
