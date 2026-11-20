import { z } from 'zod';
import type { WatcherConfig } from './watcher.js';

export const WATCHER_DEFAULT_CONCURRENCY = 6;

/** A catalog member, never a hard-coded model or household identity. */
export const watcherPanelMemberSchema = z
  .object({
    catId: z.string().min(1).max(100),
    accountRef: z.string().min(1).max(200).optional(),
  })
  .strict();

export const watcherSameFamilySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('primary') }).strict(),
  z.object({ mode: z.literal('skip') }).strict(),
  z.object({ mode: z.literal('member'), member: watcherPanelMemberSchema }).strict(),
]);

/** One global choice; the worker of each settled turn decides which branch applies. */
export const watcherRoutingConfigSchema = z
  .object({
    primary: watcherPanelMemberSchema,
    whenSameFamily: watcherSameFamilySchema,
    maxConcurrentRuns: z.number().int().min(1).max(12),
  })
  .strict();

export type WatcherRoutingConfig = z.infer<typeof watcherRoutingConfigSchema>;

/** No chosen member is an empty state, not a catalog identity. */
export function watcherPrimaryCatId(
  config: Pick<WatcherConfig, 'routing' | 'memberCatId' | 'panel'>,
): string | undefined {
  if (config.routing) return config.routing.primary.catId;
  if (config.memberCatId) return config.memberCatId;
  if (config.panel?.enabled) return config.panel.members[0]?.catId;
  return undefined;
}

/** Read-only compatibility projection, never an implicit enable or persistent migration. */
export function watcherRoutingPreference(
  config: Pick<WatcherConfig, 'routing' | 'memberCatId' | 'panel'>,
): WatcherRoutingConfig {
  return (
    config.routing ?? {
      primary: { catId: watcherPrimaryCatId(config) ?? '' },
      whenSameFamily: { mode: 'primary' },
      maxConcurrentRuns: config.panel?.maxConcurrentRuns ?? WATCHER_DEFAULT_CONCURRENCY,
    }
  );
}
export type WatcherSameFamily = z.infer<typeof watcherSameFamilySchema>;
export type WatcherObserver = z.infer<typeof watcherPanelMemberSchema>;

/** The concrete carrier must also apply this protection when it launches the member. */
export type WatcherMemberCapability =
  | { supported: true; context: 'ordinary'; readOnly: 'tools' }
  | { supported: false; reason: string };
