import {
  backgroundMetadataMatches,
  type ChatBackground,
  type ChatBackgroundMetadata,
  type ChatBackgroundMetadataEntry,
  type ChatBackgroundPreferences,
  type ChatBackgroundResponse,
  chatBackgroundMetadataEntrySchema,
  chatBackgroundSchema,
} from '@cat-cafe/shared';
import { backgroundMetadataIsCurrent } from './chat-background-file-generation.js';
import { readUserPreferencesStrict, updateUserPreferences } from './user-preferences-store.js';

function storedRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Chat background preferences contain a damaged object');
  }
  return value as Record<string, unknown>;
}

function backgroundRecords(value: unknown) {
  const stored = storedRecord(value);
  return { stored, threads: storedRecord(stored.threads) };
}

export function readChatBackgroundPreferences(projectRoot: string): ChatBackgroundResponse {
  const { stored, threads: entries } = backgroundRecords(readUserPreferencesStrict(projectRoot).chatBackgrounds);
  const global = chatBackgroundSchema.safeParse(stored.global);
  const threads: Record<string, ChatBackground> = Object.create(null);
  for (const [id, value] of Object.entries(entries)) {
    const parsed = chatBackgroundSchema.safeParse(value);
    if (parsed.success) threads[id] = parsed.data;
  }
  const metadata = backgroundRecords(stored.metadata);
  const currentMetadata = backgroundMetadataIsCurrent(projectRoot, metadata.stored);
  const globalMetadata = chatBackgroundMetadataEntrySchema.safeParse(metadata.stored.global);
  const threadMetadata: Record<string, ChatBackgroundMetadataEntry> = Object.create(null);
  for (const [id, value] of Object.entries(metadata.threads)) {
    const entry = chatBackgroundMetadataEntrySchema.safeParse(value);
    if (currentMetadata && threads[id] && entry.success && backgroundMetadataMatches(threads[id], entry.data))
      threadMetadata[id] = entry.data;
  }
  const boundGlobal =
    currentMetadata &&
    global.success &&
    globalMetadata.success &&
    backgroundMetadataMatches(global.data, globalMetadata.data)
      ? globalMetadata.data
      : undefined;
  return {
    ...(global.success ? { global: global.data } : {}),
    threads,
    ...(boundGlobal || Object.keys(threadMetadata).length
      ? { metadata: { ...(boundGlobal ? { global: boundGlobal } : {}), threads: threadMetadata } }
      : {}),
  };
}

export function saveChatBackgroundPreference(
  projectRoot: string,
  input: {
    scope: 'global' | 'thread';
    threadId?: string;
    background: ChatBackground | null;
    metadata?: ChatBackgroundMetadata;
  },
): ChatBackgroundResponse {
  updateUserPreferences(
    projectRoot,
    (current) => {
      // Preserve unknown sibling fields and future-version thread entries on disk.
      const records = backgroundRecords(current.chatBackgrounds);
      const next = { ...records.stored };
      const metadata = backgroundRecords(records.stored.metadata);
      const nextMetadata = { ...metadata.stored };
      const bound =
        input.background?.kind === 'image' && input.metadata
          ? { background: input.background, ...input.metadata }
          : undefined;
      if (input.scope === 'global') {
        if (input.background) next.global = input.background;
        else delete next.global;
        if (bound) nextMetadata.global = bound;
        else delete nextMetadata.global;
      } else if (input.threadId) {
        const threads = { ...records.threads };
        if (input.background) threads[input.threadId] = input.background;
        else delete threads[input.threadId];
        next.threads = threads;
        const entries = { ...metadata.threads };
        if (bound) entries[input.threadId] = bound;
        else delete entries[input.threadId];
        nextMetadata.threads = entries;
      }
      if (bound || records.stored.metadata !== undefined) next.metadata = nextMetadata;
      return { ...current, chatBackgrounds: next as ChatBackgroundPreferences };
    },
    {
      backgroundMetadataWrite:
        input.scope === 'global' ? { scope: 'global' } : { scope: 'thread', threadId: input.threadId ?? '' },
    },
  );
  return readChatBackgroundPreferences(projectRoot);
}
