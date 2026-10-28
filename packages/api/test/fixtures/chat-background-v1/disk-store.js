// Frozen complete v1 disk I/O from 5cef30b2f1402f506f677f7522fe7bd1bc7ab101:packages/api/src/config/user-preferences-store.ts; blob 93ffb1d926e094895472bffa483a31d9eeb63b72.
// TypeScript erased only. This fixture deliberately does not import current production I/O.
/**
 * Shared file-backed owner preference store.
 *
 * All feature-specific preference writers update through this module so one
 * setting cannot clobber another. Writes are crash-safe temp+rename and no-TTL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const MESSAGE_DISPOSITION_PRODUCT_DEFAULT = 'next_work';
function preferencesPath(projectRoot) {
  return resolve(projectRoot, '.cat-cafe', 'user-preferences.json');
}
/** Only a genuinely missing file is a writable empty profile. */
export function readUserPreferencesStrict(projectRoot) {
  const path = preferencesPath(projectRoot);
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('User preferences must be a JSON object');
  }
  return parsed;
}
/** Historical display callers may fall back; admission and writers must use strict reads. */
export function readUserPreferences(projectRoot) {
  try {
    return readUserPreferencesStrict(projectRoot);
  } catch {
    return {};
  }
}
export function updateUserPreferences(projectRoot, update, _options = {}) {
  // The single API owner cannot yield between read and atomic rename, so same-process
  // writers cannot interleave. Cross-process writers are outside runtime ownership.
  const directory = resolve(projectRoot, '.cat-cafe');
  const path = preferencesPath(projectRoot);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(directory, { recursive: true });
  const next = update(readUserPreferencesStrict(projectRoot));
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return next;
}
function isBubbleDisplayDefault(value) {
  return value === 'expanded' || value === 'collapsed';
}
function preservePreferenceRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
function sanitizeBubbleDefaults(value) {
  const candidate = preservePreferenceRecord(value);
  return isBubbleDisplayDefault(candidate.cliOutput) ? { cliOutput: candidate.cliOutput } : {};
}
export function resolveCliOutputBubbleDefault(projectRoot, fallback) {
  return sanitizeBubbleDefaults(readUserPreferences(projectRoot).bubbleDefaults).cliOutput ?? fallback;
}
export function saveCliOutputBubbleDefault(projectRoot, value) {
  updateUserPreferences(projectRoot, (current) => ({
    ...current,
    bubbleDefaults: {
      ...preservePreferenceRecord(current.bubbleDefaults),
      cliOutput: value,
    },
  }));
  return value;
}
function isDisposition(value) {
  return value === 'continue_current' || value === 'next_work';
}
function sanitizeDispositionPreferences(value) {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value;
  const threads = Object.fromEntries(
    Object.entries(candidate.threads ?? {}).filter((entry) => entry[0].length > 0 && isDisposition(entry[1])),
  );
  return {
    ...(isDisposition(candidate.global) ? { global: candidate.global } : {}),
    ...(Object.keys(threads).length > 0 ? { threads } : {}),
  };
}
export function resolveMessageDispositionPreference(projectRoot, threadId) {
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
export function saveMessageDispositionPreference(projectRoot, input) {
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
