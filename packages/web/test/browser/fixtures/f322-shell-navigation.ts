import { useMemo, useSyncExternalStore } from 'react';

// Test boundary for Next's router. Production shell navigation computes every target;
// this adapter only applies that URL to browser history and publishes route changes.
const EVENT = 'f322-fixture-route';
function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener('popstate', listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener('popstate', listener);
  };
}
function useUrl(): string {
  return useSyncExternalStore(subscribe, () => window.location.href);
}
const router = {
  push(url: string) {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new Event(EVENT));
  },
  replace(url: string) {
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new Event(EVENT));
  },
  back() {
    window.history.back();
  },
};
export const useRouter = () => router;
export const usePathname = () => new URL(useUrl()).pathname;
export function useSearchParams(): URLSearchParams {
  const url = useUrl();
  return useMemo(() => new URL(url).searchParams, [url]);
}
