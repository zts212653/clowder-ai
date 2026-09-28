import { z } from 'zod';
import {
  assetOwnerIdentity,
  bounded,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
  timestampSchema,
} from './capability-evolution-refs.js';

const exact = exactAssetVersionRefV1Schema;
const owner = ownerTruthRefV1Schema;
export const evolutionAssetReviewBlockerV1Schema = z.object({ code: bounded(120), ownerRef: owner }).strict();
const blocker = evolutionAssetReviewBlockerV1Schema;
export const evolutionOwnerHrefSchema = z
  .string()
  .max(2_000)
  .refine((href) => {
    if ([...href].some((character) => character === '\\' || character.charCodeAt(0) <= 32)) return false;
    try {
      const url = new URL(href, 'https://owner.invalid');
      return (/^\/(?!\/)/.test(href) || /^https?:\/\//.test(href)) && ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  }, 'owner href must be an app path or HTTP URL');
const source = { ownerHref: evolutionOwnerHrefSchema.optional() };

export const evolutionAssetReviewRequestV1Schema = z
  .object({
    programRef: owner,
    objectRef: owner,
    selectedVersionRef: exact.optional(),
  })
  .strict();
const versionSchema = z
  .object({
    versionRef: exact,
    title: bounded(240).optional(),
    parentEdges: z.array(z.object({ parentVersionRef: exact, edgeRef: owner }).strict()).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    for (const edge of value.parentEdges) {
      if (
        assetOwnerIdentity(edge.parentVersionRef) !== assetOwnerIdentity(value.versionRef) ||
        refIdentity(edge.parentVersionRef) === refIdentity(value.versionRef)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a derivation edge must address another version of the same owner asset',
        });
      }
    }
  });
const evidenceSchema = z
  .object({
    role: z.enum(['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation']),
    assetVersionRef: exact,
    evidenceRef: owner,
    proofRef: owner,
    status: z.enum(['verified', 'insufficient']),
    label: bounded(400).optional(),
    ...source,
  })
  .strict();
const useSchema = z
  .object({
    receiptRef: owner,
    assetVersionRef: exact,
    invocationRef: owner.refine((ref) => ref.ownerFeatureId === 'F299' && /^inv:\S+$/.test(ref.ownerStateRef)),
    consumerRef: owner,
    taskRef: owner.optional(),
    use: z.enum(['applied', 'dismissed', 'unconfirmed']),
    occurredAt: timestampSchema,
    ...source,
  })
  .strict();
const selectedSchema = z
  .object({
    versionRef: exact,
    diff: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('available'),
          comparedToVersionRef: exact,
          summary: bounded(4_000),
          rawDiffRef: owner,
          ...source,
        })
        .strict(),
      z.object({ status: z.literal('unavailable'), blocker }).strict(),
    ]),
    evidence: z.array(evidenceSchema).max(128),
    uses: z.array(useSchema).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    for (const binding of [...value.evidence, ...value.uses]) {
      if (refIdentity(binding.assetVersionRef) !== refIdentity(value.versionRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'evidence and actual use must bind the exact selected version',
        });
      }
    }
  });
const envelope = { schemaVersion: z.literal(1), programRef: owner, objectRef: owner };
export const evolutionAssetReviewV1Schema = z
  .discriminatedUnion('status', [
    z.object({ ...envelope, status: z.literal('unavailable'), blockers: z.array(blocker).min(1).max(32) }).strict(),
    z
      .object({
        ...envelope,
        status: z.literal('resolved'),
        sourceRef: owner,
        readAt: timestampSchema,
        currentVersionRefs: z.array(exact).max(128),
        currentProofRef: owner,
        versions: z.array(versionSchema).max(512),
        selected: selectedSchema.optional(),
        blockers: z.array(blocker).max(32),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.status !== 'resolved') return;
    const versions = new Set(value.versions.map((item) => refIdentity(item.versionRef)));
    if (
      versions.size !== value.versions.length ||
      value.currentVersionRefs.some((ref) => !versions.has(refIdentity(ref))) ||
      (value.selected && !versions.has(refIdentity(value.selected.versionRef)))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'current and selected versions must occur exactly in the owner catalog',
      });
    }
    const owners = value.currentVersionRefs.map(assetOwnerIdentity);
    if (new Set(owners).size !== owners.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'one live current version per owner asset' });
    const diff = value.selected?.diff;
    if (
      value.selected &&
      diff?.status === 'available' &&
      (assetOwnerIdentity(diff.comparedToVersionRef) !== assetOwnerIdentity(value.selected.versionRef) ||
        !value.currentVersionRefs.some((ref) => refIdentity(ref) === refIdentity(diff.comparedToVersionRef)))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'diff comparison must bind the live current version of the selected owner asset',
      });
  });

export type EvolutionAssetReviewRequestV1 = z.infer<typeof evolutionAssetReviewRequestV1Schema>;
export type EvolutionAssetReviewV1 = z.infer<typeof evolutionAssetReviewV1Schema>;
export type EvolutionResolvedAssetReviewV1 = Extract<EvolutionAssetReviewV1, { status: 'resolved' }>;
