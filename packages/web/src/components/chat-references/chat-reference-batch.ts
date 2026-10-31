import { type ChatReferenceTarget, chatReferenceGroupSchema } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

type Entry = {
  threadId: string;
  reference: string;
  value: ChatReferenceTarget | null | undefined;
  until: number;
  listeners: Set<() => void>;
  pending: boolean;
  inFlight: boolean;
};
const cache = new Map<string, Entry>();
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
function refreshVisible() {
  for (const entry of cache.values())
    if (entry.listeners.size && !entry.inFlight && entry.until <= Date.now()) {
      entry.pending = true;
      schedule();
    }
}

const keyFor = (thread: string, reference: string) => JSON.stringify([thread, reference]);
const keyOf = (entry: Entry) => keyFor(entry.threadId, entry.reference);
function notify(entry: Entry) {
  for (const listener of entry.listeners) listener();
}

async function flush() {
  timer = undefined;
  const pending = [...cache.values()].filter((entry) => entry.pending && !entry.inFlight && entry.listeners.size);
  const groups = new Map<string, Entry[]>();
  let count = 0;
  for (const entry of pending) {
    if (count >= 128) break;
    const group = groups.get(entry.threadId) ?? [];
    if (group.length >= 64 || (!groups.has(entry.threadId) && groups.size >= 8)) continue;
    group.push(entry);
    count++;
    groups.set(entry.threadId, group);
  }
  const entries = [...groups.values()].flat();
  for (const entry of entries) {
    entry.pending = false;
    entry.inFlight = true;
  }
  if (!entries.length) return;
  try {
    const response = await apiFetch('/api/workspace/chat-references', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groups: [...groups].map(([threadId, items]) => ({ threadId, references: items.map((item) => item.reference) })),
      }),
    });
    const raw: unknown = response.ok ? await response.json() : null;
    const values = raw && typeof raw === 'object' && 'groups' in raw && Array.isArray(raw.groups) ? raw.groups : [];
    const resolved = new Map<string, ChatReferenceTarget | null>();
    for (const value of values) {
      const group = chatReferenceGroupSchema.safeParse(value);
      if (group.success)
        for (const item of group.data.results) resolved.set(keyFor(group.data.threadId, item.reference), item.target);
    }
    for (const entry of entries) {
      entry.value = resolved.get(keyOf(entry)) ?? null;
      entry.until = Date.now() + (entry.value ? 30_000 : 5000);
      notify(entry);
    }
  } catch {
    for (const entry of entries) {
      entry.value = null;
      entry.until = Date.now() + 5000;
      notify(entry);
    }
  } finally {
    for (const entry of entries) entry.inFlight = false;
    if ([...cache.values()].some((entry) => entry.pending && !entry.inFlight && entry.listeners.size)) schedule();
  }
}
function schedule() {
  timer ??= setTimeout(() => void flush(), 8);
}
function entryFor(threadId: string, reference: string): Entry {
  const key = keyFor(threadId, reference);
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= 2048)
      for (const [id, value] of cache)
        if (!value.listeners.size && !value.pending && !value.inFlight) {
          cache.delete(id);
          break;
        }
    entry = { threadId, reference, value: undefined, until: 0, listeners: new Set(), pending: false, inFlight: false };
    cache.set(key, entry);
  }
  return entry;
}
export const chatReferenceBatch = {
  read: (threadId: string, reference: string) => entryFor(threadId, reference).value,
  subscribe(threadId: string, reference: string, listener: () => void) {
    const entry = entryFor(threadId, reference);
    entry.listeners.add(listener);
    if (!entry.inFlight && entry.until <= Date.now()) {
      entry.pending = true;
      schedule();
    }
    if (!refreshTimer) {
      refreshTimer = setInterval(refreshVisible, 30_000);
      window.addEventListener('focus', refreshVisible);
    }
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) entry.pending = false;
      if (![...cache.values()].some((value) => value.listeners.size)) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
        window.removeEventListener('focus', refreshVisible);
      }
    };
  },
  refresh(threadId: string, reference: string) {
    const entry = entryFor(threadId, reference);
    entry.until = 0;
    entry.pending = entry.listeners.size > 0;
    if (entry.pending) schedule();
  },
};
