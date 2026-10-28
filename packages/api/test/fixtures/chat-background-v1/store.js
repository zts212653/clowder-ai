// Frozen v1 reader from 5cef30b2f1402f506f677f7522fe7bd1bc7ab101:packages/api/src/config/user-preferences-chat-background.ts; blob 0b84887fa1849bccfb68c2f38e9017f5bf562cec.
// TypeScript erased; imports point to the frozen schema and complete frozen v1 disk I/O.

import { readUserPreferencesStrict, updateUserPreferences } from './disk-store.js';
import { chatBackgroundSchema } from './schema.js';

function storedRecord(value) {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Chat background preferences contain a damaged object');
  }
  return value;
}
function backgroundRecords(value) {
  const stored = storedRecord(value);
  return { stored, threads: storedRecord(stored.threads) };
}
export function readChatBackgroundPreferences(projectRoot) {
  const { stored, threads: entries } = backgroundRecords(readUserPreferencesStrict(projectRoot).chatBackgrounds);
  const global = chatBackgroundSchema.safeParse(stored.global);
  const threads = Object.create(null);
  for (const [id, value] of Object.entries(entries)) {
    const parsed = chatBackgroundSchema.safeParse(value);
    if (parsed.success) threads[id] = parsed.data;
  }
  return { ...(global.success ? { global: global.data } : {}), threads };
}
export function saveChatBackgroundPreference(projectRoot, input) {
  updateUserPreferences(projectRoot, (current) => {
    // Preserve unknown sibling fields and future-version thread entries on disk.
    const records = backgroundRecords(current.chatBackgrounds);
    const next = { ...records.stored };
    if (input.scope === 'global') {
      if (input.background) next.global = input.background;
      else delete next.global;
    } else if (input.threadId) {
      const threads = { ...records.threads };
      if (input.background) threads[input.threadId] = input.background;
      else delete threads[input.threadId];
      next.threads = threads;
    }
    return { ...current, chatBackgrounds: next };
  });
  return readChatBackgroundPreferences(projectRoot);
}
