/** sessionStorage holds a routing nonce; all association/ref payloads remain durable in localStorage. */
const SCOPE_KEY = 'cat-cafe:settings-reading-scope:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let documentScope: string | undefined;
let claim: Promise<{ id: string; restorable: boolean }> | undefined;
let routingStored = false;

function activate(id: string): string {
  documentScope = id;
  try {
    window.sessionStorage.setItem(SCOPE_KEY, id);
    routingStored = true;
  } catch {
    routingStored = false;
  }
  return id;
}
export function getSettingsReadingScope(): string {
  if (documentScope) return documentScope;
  if (typeof window === 'undefined') return 'server';
  try {
    const saved = window.sessionStorage.getItem(SCOPE_KEY);
    if (saved && UUID.test(saved) && navigator.locks) {
      documentScope = saved;
      routingStored = true;
      return saved;
    }
  } catch {
    /* A document-only scope can still provide honest, isolated navigation. */
  }
  return activate(crypto.randomUUID());
}

/** A copied nonce cannot claim another live tab's scope. Document teardown releases its native lock. */
export function claimSettingsReadingScope(): Promise<{ id: string; restorable: boolean }> {
  if (claim) return claim;
  const id = getSettingsReadingScope();
  if (!navigator.locks) return Promise.resolve({ id, restorable: false });
  const acquire = (scope: string) =>
    new Promise<boolean>((resolve, reject) => {
      void navigator.locks
        .request(`cat-cafe:settings-reading-scope:${scope}`, { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          if (lock) return new Promise<void>(() => {});
        })
        .catch(reject);
    });
  claim = (async () => {
    try {
      if (await acquire(id)) return { id, restorable: routingStored };
      const isolated = activate(crypto.randomUUID());
      return { id: isolated, restorable: (await acquire(isolated)) && routingStored };
    } catch {
      return { id: activate(crypto.randomUUID()), restorable: false };
    }
  })();
  return claim;
}
