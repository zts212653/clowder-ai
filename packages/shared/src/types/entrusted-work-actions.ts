import { z } from 'zod';
import { type EntrustedWorkV1, entrustedWorkV1Schema, growingSourceMessageRevisionV1Schema } from './growing.js';

const boundedRef = z.string().trim().min(1).max(1_000);
const boundedText = z.string().trim().min(1).max(4_000);
const revisionCoordinate = z.union([boundedRef, z.number().int().positive()]);

export const custodyAuthorityProvenanceV1Schema = z
  .object({
    grantRef: boundedRef,
    grantRevision: revisionCoordinate,
    producerRef: boundedRef,
    grantOwnerRef: boundedRef,
    grantOwnerRevision: revisionCoordinate,
    sourceRef: boundedRef,
    sourceRevision: revisionCoordinate,
    matchedScope: boundedRef,
    admissionAuthority: z.literal('task_admit_or_resume'),
    idempotencySource: z.enum(['source_ref_and_revision', 'producer_event_ref_and_revision']),
  })
  .strict();

const admissionBase = {
  sourceRefs: z.array(boundedRef).min(1).max(64),
  intendedOutcome: boundedText.optional(),
  timeHints: z.array(boundedText).max(16).optional(),
  idempotencyKey: boundedRef,
};

export const custodyAdmissionRequestV1Schema = z.discriminatedUnion('basis', [
  z.object({ ...admissionBase, basis: z.literal('explicit_entrustment') }).strict(),
  z
    .object({
      ...admissionBase,
      basis: z.literal('accepted_offer'),
      offerId: boundedRef,
      sourceMessageRevision: growingSourceMessageRevisionV1Schema,
    })
    .strict(),
  z
    .object({
      ...admissionBase,
      basis: z.literal('authorized_source'),
      authorityProvenance: custodyAuthorityProvenanceV1Schema,
    })
    .strict(),
]);

export const entrustedWorkClosureSpecV1Schema = z
  .object({
    condition: boundedText,
    expectedSignal: boundedRef,
  })
  .strict();

export const entrustedWorkTerminalClosureV1Schema = entrustedWorkV1Schema.shape.closure.refine(
  (closure) => closure.state !== 'open',
  { message: 'closure action must be terminal' },
);

export const entrustedWorkTerminalActionV1Schema = z
  .object({
    expectedRevision: z.number().int().positive(),
    closure: entrustedWorkTerminalClosureV1Schema,
  })
  .strict();

const entrustedWorkTimeFactV1Schema = entrustedWorkV1Schema.shape.time.shape.businessDeadline.unwrap();

/** Task-owner-only nonterminal mutation; absence of mutation fields is rejected by the lifecycle owner. */
export const entrustedWorkUpdateActionV1Schema = z
  .object({
    taskId: boundedRef,
    expectedRevision: z.number().int().positive(),
    time: z
      .object({
        businessDeadline: entrustedWorkTimeFactV1Schema.nullable().optional(),
        reviewBy: entrustedWorkTimeFactV1Schema.nullable().optional(),
      })
      .strict()
      .optional(),
    artifactRefs: z.array(boundedRef).max(64).optional(),
  })
  .strict();

export const registeredCustodyGrantV1Schema = z
  .object({
    grantRef: boundedRef,
    revision: revisionCoordinate,
    producerRef: boundedRef,
    grantOwnerRef: boundedRef,
    grantOwnerRevision: revisionCoordinate,
    allowedSourceScope: z.array(boundedRef).min(1).max(64),
    admissionAuthority: z.literal('task_admit_or_resume'),
    validity: z.discriminatedUnion('state', [
      z.object({ state: z.literal('current'), expiresAt: z.string().datetime().nullable() }).strict(),
      z
        .object({
          state: z.literal('revoked'),
          revokedAt: z.string().datetime(),
          revocationRevision: revisionCoordinate,
        })
        .strict(),
    ]),
    idempotencySource: z.enum(['source_ref_and_revision', 'producer_event_ref_and_revision']),
  })
  .strict();

export type CustodyAuthorityProvenanceV1 = z.infer<typeof custodyAuthorityProvenanceV1Schema>;
export type CustodyAdmissionRequestV1 = z.infer<typeof custodyAdmissionRequestV1Schema>;
export type EntrustedWorkClosureSpecV1 = z.infer<typeof entrustedWorkClosureSpecV1Schema>;
export type EntrustedWorkTerminalClosureV1 = Exclude<EntrustedWorkV1['closure'], { state: 'open' }>;
export type EntrustedWorkTerminalActionV1 = {
  readonly expectedRevision: number;
  readonly closure: EntrustedWorkTerminalClosureV1;
};
export type EntrustedWorkUpdateActionV1 = z.infer<typeof entrustedWorkUpdateActionV1Schema>;
export type RegisteredCustodyGrantV1 = z.infer<typeof registeredCustodyGrantV1Schema>;
export type F310CustodyGrantRegistryV1 = Readonly<Record<string, RegisteredCustodyGrantV1>>;

export const PHASE_B_INITIAL_CUSTODY_GRANT_REGISTRY: F310CustodyGrantRegistryV1 = Object.freeze({});
