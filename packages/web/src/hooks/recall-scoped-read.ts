import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { waitForPromiseWithSignal } from '@/utils/bounded-fetch';

interface PendingRead {
  controller: AbortController;
  promise: Promise<unknown>;
  consumers: number;
  settled: boolean;
}
const pending = new Map<string, PendingRead>();

/** Share only an active exact-scope read; no response survives as an authority cache. */
export async function readScopedRecallJson(path: string, version: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const identity = apiSessionIdentity.getSnapshot();
  const key = JSON.stringify([identity.ownerUserId, identity.generation, version, path]);
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created: PendingRead = { controller, consumers: 0, settled: false, promise: Promise.resolve() };
    created.promise = apiFetch(path, { signal: controller.signal }, { afterCurrentGet: true })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Recall read unavailable (${response.status})`);
        return response.json() as Promise<unknown>;
      })
      .finally(() => {
        created.settled = true;
        if (pending.get(key) === created) pending.delete(key);
      });
    pending.set(key, created);
    entry = created;
  }
  const current = entry;
  current.consumers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    current.consumers--;
    if (!current.consumers && !current.settled) {
      if (pending.get(key) === current) pending.delete(key);
      current.controller.abort();
    }
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    const result = await waitForPromiseWithSignal(current.promise, signal);
    if (apiSessionIdentity.getSnapshot().generation !== identity.generation)
      throw new DOMException('Recall session changed', 'AbortError');
    return result;
  } finally {
    signal.removeEventListener('abort', release);
    release();
  }
}
