import { z } from 'zod';

export const MAX_QUOTA_PIN_ACCOUNTS = 32;

export const quotaPinPreferenceSchema = z
  .object({
    /** Default true per operator decision: shown on WorldRail until user hides it. */
    pinned: z.boolean().default(true),
    /** Null = automatic default selection; explicit array = user's chosen accountRefs. */
    selectedAccountRefs: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_QUOTA_PIN_ACCOUNTS)
      .nullable()
      .default(null),
  })
  .strict();

export const quotaPinPreferencePatchSchema = z
  .object({
    pinned: z.boolean().optional(),
    selectedAccountRefs: z.array(z.string().trim().min(1).max(200)).max(MAX_QUOTA_PIN_ACCOUNTS).nullable().optional(),
  })
  .strict();

export type QuotaPinPreference = z.infer<typeof quotaPinPreferenceSchema>;
export type QuotaPinPreferencePatch = z.infer<typeof quotaPinPreferencePatchSchema>;
