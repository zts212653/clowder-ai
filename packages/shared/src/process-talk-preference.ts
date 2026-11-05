import { z } from 'zod';

export const processTalkModeSchema = z.enum(['whole', 'record']);
export type ProcessTalkMode = z.infer<typeof processTalkModeSchema>;
export const processTalkPreferenceSchema = z
  .object({
    ownerUserId: z.string().min(1).max(256),
    mode: processTalkModeSchema,
  })
  .strict();
export type ProcessTalkPreference = z.infer<typeof processTalkPreferenceSchema>;
export const processTalkChangeSchema = z
  .object({
    expectedOwnerUserId: z.string().min(1).max(256),
    mode: processTalkModeSchema,
  })
  .strict();
