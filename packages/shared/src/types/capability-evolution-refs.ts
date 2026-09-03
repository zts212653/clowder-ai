// biome-ignore-all format: Compact ref primitives stay readable as one contract block.
import { z } from 'zod';

/**
 * F311 ref primitives, extracted so both the Program state machine and the Phase 3 diagnosis
 * snapshot can share one definition without an import cycle. Owner state refs are deliberately
 * `kind:id` shaped: a ref can address owner truth, but it can never smuggle owner payload.
 */
export const bounded = (max: number) => z.string().trim().min(1).max(max);
export const timestampSchema = z.string().datetime({ offset: true });
const ownerStateRefSchema = bounded(500).regex(/^[a-z][a-z0-9-]*:[^\s{}[\]"']+$/, 'owner state refs must use non-payload kind:id syntax');
export const refShape = {
  ownerFeatureId: bounded(120),
  ownerStateRef: ownerStateRefSchema,
  version: bounded(240).optional(),
};
export const strictEvent = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const ownerTruthRefV1Schema = z.object(refShape).strict();
export const assetVersionRefV1Schema = z
  .object({ ...refShape, assetKind: bounded(120), assetId: bounded(240) })
  .strict();
export const exactAssetVersionRefV1Schema = z
  .object({ ...refShape, version: bounded(240), assetKind: bounded(120), assetId: bounded(240) })
  .strict();

export type OwnerTruthRefV1 = z.infer<typeof ownerTruthRefV1Schema>;
export type AssetVersionRefV1 = z.infer<typeof assetVersionRefV1Schema>;
export type ExactAssetVersionRefV1 = z.infer<typeof exactAssetVersionRefV1Schema>;

/**
 * Canonical ref identity. Comparing only `ownerStateRef` silently treats v1 and v2 of the same
 * cohort as one thing — which is exactly how a moved ruler passes as "unchanged". Every dedupe,
 * reuse check and drift check must go through this one function.
 * The separator is an escaped NUL so it can never occur inside a ref and the source stays text.
 */
const isAssetRef = (ref: OwnerTruthRefV1): ref is AssetVersionRefV1 =>
  typeof (ref as AssetVersionRefV1).assetKind === 'string' && typeof (ref as AssetVersionRefV1).assetId === 'string';

/**
 * Unambiguous tuple encoding rather than a delimiter-joined string: any separator character can
 * in principle occur inside a field, and two different refs that encode to one key is precisely
 * how "same cohort" / "same rubric" mistakes get made. JSON array encoding cannot collide.
 *
 * Asset identity is part of the identity when present — a ref that names a rubric version is not
 * interchangeable with a bare owner ref that happens to share an ownerStateRef.
 */
export const refIdentity = (ref: OwnerTruthRefV1): string =>
  JSON.stringify(
    isAssetRef(ref)
      ? ['asset', ref.ownerFeatureId, ref.ownerStateRef, ref.version ?? null, ref.assetKind, ref.assetId]
      : ['owner', ref.ownerFeatureId, ref.ownerStateRef, ref.version ?? null],
  );

/** Asset refs always encode their asset identity; kind/id changes are real changes. */
export const assetRefIdentity = (ref: AssetVersionRefV1): string => refIdentity(ref);