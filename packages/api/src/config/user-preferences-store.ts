/**
 * Shared file-backed owner preference store.
 *
 * All feature-specific preference writers must update through this module so
 * one setting cannot clobber another. Writes are crash-safe temp+rename and
 * preferences intentionally have no TTL.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  MessageDispositionPreferenceSnapshot,
  MessageDispositionPreferences,
  MessageWorkDisposition,
  UserPreferences,
} from '@cat-cafe/shared';

export const MESSAGE_DISPOSITION_PRODUCT_DEFAULT: MessageWorkDisposition = 'next_work';

function preferencesPath(projectRoot: string): string {
  return resolve(projectRoot, '.cat-cafe', 'user-preferences.json');
}

export function readUserPreferences(projectRoot: string): UserPreferences {
  const path = preferencesPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as UserPreferences) : {};
  } catch {
    return {};
  }
}

export function updateUserPreferences(
  projectRoot: string,
  update: (current: UserPreferences) => UserPreferences,
): UserPreferences {
  const directory = resolve(projectRoot, '.cat-cafe');
  const path = preferencesPath(projectRoot);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(directory, { recursive: true });
  const next = update(readUserPreferences(projectRoot));
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return next;
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
    ...(candidate.onboardingSeen === true ? { onboardingSeen: true } : {}),
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
      onboardingSeen: preference.onboardingSeen === true,
    };
  }
  if (global) {
    return {
      productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
      global,
      thread: null,
      effective: global,
      source: 'global',
      onboardingSeen: preference.onboardingSeen === true,
    };
  }
  return {
    productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
    global: null,
    thread: null,
    effective: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
    source: 'product',
    onboardingSeen: preference.onboardingSeen === true,
  };
}

export function saveMessageDispositionPreference(
  projectRoot: string,
  input:
    | { scope: 'global'; disposition: MessageWorkDisposition | null }
    | { scope: 'thread'; threadId: string; disposition: MessageWorkDisposition | null }
    | { scope: 'onboarding'; seen: true },
): MessageDispositionPreferenceSnapshot {
  updateUserPreferences(projectRoot, (current) => {
    const existing = sanitizeDispositionPreferences(current.messageDisposition);
    if (input.scope === 'onboarding') {
      return { ...current, messageDisposition: { ...existing, onboardingSeen: true } };
    }
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
