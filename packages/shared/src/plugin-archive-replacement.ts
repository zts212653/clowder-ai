import { z } from 'zod';

// Canonical SHA-512 SRI, including the final base64 padding bits; browser-safe.
const digest = z.string().regex(/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/);
const revision = z.number().int().safe().min(1);

/** A compare-and-swap fence, never authentication or a permission grant. */
export const PluginArchiveReplacementConfirmationSchema = z
  .object({
    pluginId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    pluginInstanceId: z.string().min(1).max(256),
    currentPackageDigest: digest,
    candidatePackageDigest: digest,
    expectedLifecycleRevision: revision,
    expectedGrantRevision: revision,
    candidateEffectiveGrants: z.array(z.string().min(1).max(128)).max(256),
  })
  .strict();

export type PluginArchiveReplacementConfirmation = z.infer<typeof PluginArchiveReplacementConfirmationSchema>;

export const PluginArchiveReplacementOfferSchema = z
  .object({
    confirmation: PluginArchiveReplacementConfirmationSchema,
    displayName: z.string().min(1),
    currentVersion: z.string().min(1),
    candidateVersion: z.string().min(1),
  })
  .strict();

export type PluginArchiveReplacementOffer = z.infer<typeof PluginArchiveReplacementOfferSchema>;
