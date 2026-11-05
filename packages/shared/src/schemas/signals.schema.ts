/**
 * Signal Hunter schemas
 */

import { z } from 'zod';

export const SignalTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const SignalCategorySchema = z.enum(['official', 'papers', 'research', 'engineering', 'community', 'other']);

export const SignalFetchMethodSchema = z.enum(['rss', 'api', 'webpage']);

export const SignalScheduleFrequencySchema = z.enum(['hourly', 'daily', 'weekly', 'manual']);

export const SignalKeywordFilterSchema = z.object({
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
});

export const SignalSourceFetchConfigSchema = z.object({
  method: SignalFetchMethodSchema,
  selector: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  headers: z.record(z.string()).optional(),
});

export const SignalSourceScheduleSchema = z.object({
  frequency: SignalScheduleFrequencySchema,
});

export const SignalSourceSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'source id must be a safe slug (letters, numbers, "_" or "-")'),
  name: z.string().min(1),
  url: z.string().url(),
  tier: SignalTierSchema,
  category: SignalCategorySchema,
  enabled: z.boolean(),
  fetch: SignalSourceFetchConfigSchema,
  schedule: SignalSourceScheduleSchema,
  filters: z
    .object({
      keywords: SignalKeywordFilterSchema.optional(),
      /** Keep only articles published within this many days; undated articles are kept. */
      maxAgeDays: z.number().int().positive().optional(),
    })
    .optional(),
});

export const SignalSourceConfigSchema = z.object({
  version: z.literal(1),
  sources: z.array(SignalSourceSchema),
});

export const SignalArticleStatusSchema = z.enum(['inbox', 'read', 'archived', 'starred']);

export const SignalArticleSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  source: z.string().min(1),
  tier: SignalTierSchema,
  publishedAt: z.string().min(1),
  fetchedAt: z.string().min(1),
  status: SignalArticleStatusSchema,
  tags: z.array(z.string()),
  summary: z.string().optional(),
  filePath: z.string().min(1),
  note: z.string().optional(),
  deletedAt: z.string().optional(),
  studyCount: z.number().int().nonnegative().optional(),
  lastStudiedAt: z.string().optional(),
});

export const SignalArticleUpdateSchema = z.object({
  status: SignalArticleStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  note: z.string().optional(),
  deletedAt: z.string().optional(),
});

export type SignalSourceInput = z.infer<typeof SignalSourceSchema>;
export type SignalArticleInput = z.infer<typeof SignalArticleSchema>;
export type SignalArticleUpdateInput = z.infer<typeof SignalArticleUpdateSchema>;
