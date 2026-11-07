import { openDB as openRealDB } from 'idb';

declare global {
  interface Window {
    draftWriteGate?: { promise: Promise<void>; release: () => void; started: number };
    draftReadRelease?: () => void;
    draftSendCalls: number;
  }
}

// Only the new-conversation storage import uses this boundary. All database
// operations still use Chromium IndexedDB after the explicit test gate opens.
export async function openDB(...args: Parameters<typeof openRealDB>) {
  const database = await openRealDB(...args);
  return new Proxy(database, {
    get(target, property) {
      if (property === 'put') {
        return async (...values: Parameters<typeof database.put>) => {
          const gate = window.draftWriteGate;
          if (gate) {
            gate.started += 1;
            await gate.promise;
          }
          return database.put(...values);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function useSendMessage() {
  return {
    handleSend: async () => {
      window.draftSendCalls += 1;
      return true;
    },
    uploadStatus: 'idle',
    uploadError: null,
  };
}

export function RecentWorks() {
  return null;
}
export function SessionImportPanel() {
  return null;
}
export function DemoEntryActions() {
  return null;
}
export function useRouter() {
  return { push() {}, replace() {}, prefetch() {} };
}
export function usePathname() {
  return '/';
}
export function useSearchParams() {
  return new URLSearchParams();
}
export default function Image({ src, alt }: { src: string; alt: string }) {
  // biome-ignore lint/performance/noImgElement: This fixture replaces the Next image wrapper in an isolated browser bundle.
  return <img src={src} alt={alt} />;
}
