import { z } from 'zod';
import {
  bounded,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  timestampSchema,
} from './capability-evolution-refs.js';

/**
 * Durable Chat provenance written only after the capability owner records an exact-use receipt.
 * It is a read/navigation carrier, never authority to mutate or roll back the owner asset.
 */
export const evolutionUseSourceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    programId: bounded(240).regex(/^evolution-program:[0-9a-f]{32}$/u),
    assetVersionRef: exactAssetVersionRefV1Schema,
    receiptRef: ownerTruthRefV1Schema,
    use: z.enum(['applied', 'unconfirmed']),
    recordedAt: timestampSchema,
  })
  .strict();

export type EvolutionUseSourceV1 = z.infer<typeof evolutionUseSourceV1Schema>;
