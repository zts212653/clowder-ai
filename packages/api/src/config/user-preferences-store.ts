/**
 * Shared file-backed owner preference store.
 *
 * All feature-specific preference writers update through this module so one
 * setting cannot clobber another. Writes are crash-safe temp+rename and no-TTL.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  MessageDispositionPreferenceSnapshot,
  MessageDispositionPreferences,
  MessageWorkDisposition,
  UserPreferences,
} from '@cat-cafe/shared';
import { userPreferencesPath } from './chat-background-file-generation.js';
import type { BackgroundMetadataWrite } from './chat-background-metadata-lifecycle.js';
import { writeUserPreferencesAtomic } from './user-preferences-atomic-write.js';

type BubbleDefaultPreferences = NonNullable<UserPreferences['bubbleDefaults']>;
type BubbleDisplayDefaultPreference = NonNullable<BubbleDefaultPreferences['cliOutput']>;

export const MESSAGE_DISPOSITION_PRODUCT_DEFAULT: MessageWorkDisposition = 'next_work';

/** Only a genuinely missing file is a writable empty profile. */
export function readUserPreferencesStrict(projectRoot: string): UserPreferences {
  const path = userPreferencesPath(projectRoot);
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('User preferences must be a JSON object');
  }
  return parsed as UserPreferences;
}

/** Historical display callers may fall back; admission and writers must use strict reads. */
export function readUserPreferences(projectRoot: string): UserPreferences {
  try {
    return readUserPreferencesStrict(projectRoot);
  } catch {
    return {};
  }
}

export function updateUserPreferences(
  projectRoot: string,
  update: (current: UserPreferences) => UserPreferences,
  options: { strictRead?: boolean; backgroundMetadataWrite?: BackgroundMetadataWrite } = {},
): UserPreferences {
  // The single API owner cannot yield between read and atomic rename, so same-process
  // writers cannot interleave. Cross-process writers are outside runtime ownership.
  const directory = resolve(projectRoot, '.cat-cafe');
  mkdirSync(directory, { recursive: true });
  const current = readUserPreferencesStrict(projectRoot);
  const previousBackgrounds = { chatBackgrounds: structuredClone(current.chatBackgrounds) };
  return writeUserPreferencesAtomic(projectRoot, previousBackgrounds, update(current), options.backgroundMetadataWrite);
}

function isBubbleDisplayDefault(value: unknown): value is BubbleDisplayDefaultPreference {
  return value === 'expanded' || value === 'collapsed';
}

function preservePreferenceRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sanitizeBubbleDefaults(value: unknown): BubbleDefaultPreferences {
  const candidate = preservePreferenceRecord(value);
  return isBubbleDisplayDefault(candidate.cliOutput) ? { cliOutput: candidate.cliOutput } : {};
}

export function resolveCliOutputBubbleDefault(
  projectRoot: string,
  fallback: BubbleDisplayDefaultPreference,
): BubbleDisplayDefaultPreference {
  return sanitizeBubbleDefaults(readUserPreferences(projectRoot).bubbleDefaults).cliOutput ?? fallback;
}

export function saveCliOutputBubbleDefault(
  projectRoot: string,
  value: BubbleDisplayDefaultPreference,
): BubbleDisplayDefaultPreference {
  updateUserPreferences(projectRoot, (current) => ({
    ...current,
    bubbleDefaults: {
      ...preservePreferenceRecord(current.bubbleDefaults),
      cliOutput: value,
    },
  }));
  return value;
}

function isDisposition(value: unknown): value is MessageWorkDisposition {
  return value === 'continue_current' || value === 'next_work';
}

function sanitizeDispositionPreferences(value: unknown): MessageDispositionPreferences {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value as MessageDispositionPreferences;
  const threads = Object.fromEntries(
    Object.entries(candidate.threads ?? {}).filter(
      (entry): entry is [string, MessageWorkDisposition] => entry[0].length > 0 && isDisposition(entry[1]),
    ),
  );
  return {
    ...(isDisposition(candidate.global) ? { global: candidate.global } : {}),
    ...(Object.keys(threads).length > 0 ? { threads } : {}),
  };
}

export function resolveMessageDispositionPreference(
  projectRoot: string,
  threadId?: string,
): MessageDispositionPreferenceSnapshot {
  const preference = sanitizeDispositionPreferences(readUserPreferences(projectRoot).messageDisposition);
  const thread = threadId ? (preference.threads?.[threadId] ?? null) : null;
  const global = preference.global ?? null;
  if (thread) {
    return {
      productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
      global,
      thread,
      effective: thread,
      source: 'thread',
    };
  }
  if (global) {
    return {
      productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
      global,
      thread: null,
      effective: global,
      source: 'global',
    };
  }
  return {
    productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
    global: null,
    thread: null,
    effective: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
    source: 'product',
  };
}

export function saveMessageDispositionPreference(
  projectRoot: string,
  input:
    | { scope: 'global'; disposition: MessageWorkDisposition | null }
    | { scope: 'thread'; threadId: string; disposition: MessageWorkDisposition | null },
): MessageDispositionPreferenceSnapshot {
  updateUserPreferences(projectRoot, (current) => {
    const existing = sanitizeDispositionPreferences(current.messageDisposition);
    if (input.scope === 'global') {
      const next = { ...existing };
      if (input.disposition) next.global = input.disposition;
      else delete next.global;
      return { ...current, messageDisposition: next };
    }
    const threads = { ...(existing.threads ?? {}) };
    if (input.disposition) threads[input.threadId] = input.disposition;
    else delete threads[input.threadId];
    const next = { ...existing };
    if (Object.keys(threads).length > 0) next.threads = threads;
    else delete next.threads;
    return { ...current, messageDisposition: next };
  });
  return resolveMessageDispositionPreference(projectRoot, input.scope === 'thread' ? input.threadId : undefined);
}
