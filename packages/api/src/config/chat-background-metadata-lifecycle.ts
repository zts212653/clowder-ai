import {
  backgroundMetadataMatches,
  chatBackgroundMetadataEntrySchema,
  chatBackgroundSchema,
  type UserPreferences,
} from '@cat-cafe/shared';

export type BackgroundMetadataWrite = { scope: 'global' } | { scope: 'thread'; threadId: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function storedBackgroundMetadata(preferences: UserPreferences): unknown {
  return record(preferences.chatBackgrounds)?.metadata;
}

export function hasBackgroundMetadataBindings(preferences: UserPreferences): boolean {
  const metadata = record(storedBackgroundMetadata(preferences));
  if (!metadata || (metadata.threads !== undefined && !record(metadata.threads))) return false;
  return (
    chatBackgroundMetadataEntrySchema.safeParse(metadata?.global).success ||
    Object.values(record(metadata?.threads) ?? {}).some(
      (value) => chatBackgroundMetadataEntrySchema.safeParse(value).success,
    )
  );
}

/** Only a canonical write can carry a seal forward. Opaque old whole-file writes never get re-attested. */
export function sealBackgroundMetadata(
  previous: UserPreferences,
  next: UserPreferences,
  trustedPrevious: boolean,
  nextGeneration: string | undefined,
  write?: BackgroundMetadataWrite,
): UserPreferences {
  const backgrounds = record(next.chatBackgrounds);
  const metadata = record(backgrounds?.metadata);
  if (!backgrounds || !metadata) return next;
  const sealed: Record<string, unknown> = { ...metadata };
  // Even malformed/unknown containers cannot carry an old proof into a new file.
  delete sealed.fileIdentity;
  delete sealed.fileGeneration;
  if (metadata.threads !== undefined && !record(metadata.threads)) {
    return {
      ...next,
      chatBackgrounds: { ...backgrounds, metadata: sealed } as unknown as UserPreferences['chatBackgrounds'],
    };
  }
  const previousBackgrounds = record(previous.chatBackgrounds);
  const previousMetadata = record(previousBackgrounds?.metadata);
  const keep = (value: unknown, background: unknown, old: unknown, oldBackground: unknown, fresh: boolean) => {
    const entry = chatBackgroundMetadataEntrySchema.safeParse(value);
    if (!entry.success) return value; // Preserve unknown future-version entries; current readers still reject them.
    const core = chatBackgroundSchema.safeParse(background);
    if (!core.success || !backgroundMetadataMatches(core.data, entry.data)) return undefined;
    if (fresh) return value;
    const prior = chatBackgroundMetadataEntrySchema.safeParse(old);
    const oldCore = chatBackgroundSchema.safeParse(oldBackground);
    return trustedPrevious &&
      prior.success &&
      oldCore.success &&
      backgroundMetadataMatches(oldCore.data, prior.data) &&
      JSON.stringify(entry.data) === JSON.stringify(prior.data)
      ? value
      : undefined;
  };
  const boundGlobal = keep(
    metadata.global,
    backgrounds.global,
    previousMetadata?.global,
    previousBackgrounds?.global,
    write?.scope === 'global',
  );
  const boundThreads = { ...record(metadata.threads) };
  const threads = record(backgrounds.threads);
  const oldThreads = record(previousBackgrounds?.threads);
  const oldEntries = record(previousMetadata?.threads);
  for (const [id, value] of Object.entries(boundThreads)) {
    const bound = keep(
      value,
      threads?.[id],
      oldEntries?.[id],
      oldThreads?.[id],
      write?.scope === 'thread' && write.threadId === id,
    );
    if (bound === undefined) delete boundThreads[id];
    else boundThreads[id] = bound;
  }
  sealed.threads = boundThreads;
  if (nextGeneration) sealed.fileGeneration = nextGeneration;
  if (boundGlobal === undefined) delete sealed.global;
  else sealed.global = boundGlobal;
  return {
    ...next,
    // Disk preservation deliberately includes opaque future fields outside the public v1 projection.
    chatBackgrounds: { ...backgrounds, metadata: sealed } as unknown as UserPreferences['chatBackgrounds'],
  };
}
