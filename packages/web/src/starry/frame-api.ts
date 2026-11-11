import { useSyncExternalStore } from 'react';

export const API_URL = '';

const pending = new Map<string, (response: Response) => void>();
const visibilityListeners = new Set<() => void>();
let visible = false;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'clowder-frame-lifecycle' && typeof message.visible === 'boolean') {
      if (visible === message.visible) return;
      visible = message.visible;
      for (const listener of visibilityListeners) listener();
    }
    if (message?.type !== 'clowder-frame-response') return;
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(
      new Response(JSON.stringify(message.body), {
        status: message.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    window.parent.postMessage(
      {
        type: 'clowder-frame-request',
        id,
        method: init?.method ?? 'GET',
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      },
      window.location.origin,
    );
  });
}

// Asset requests keep their original URLs; API fetches in the reused source graph share the bridge.
export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (!url.pathname.startsWith('/api/')) return globalThis.fetch(input, init);
  return apiFetch(url.origin === window.location.origin ? url.pathname + url.search : url.href, init);
}

function subscribeVisibility(listener: () => void) {
  visibilityListeners.add(listener);
  return () => visibilityListeners.delete(listener);
}

export function useFrameVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => visible,
    () => false,
  );
}
