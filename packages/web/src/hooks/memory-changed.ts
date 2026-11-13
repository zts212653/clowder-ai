export const MEMORY_CHANGED = 'cat-cafe:memory-changed';
export const MEMORY_CHANGED_STORAGE_KEY = 'cat-cafe:memory-change-signal';
export function notifyMemoryChanged(): void {
  window.dispatchEvent(new Event(MEMORY_CHANGED));
  try {
    localStorage.setItem(MEMORY_CHANGED_STORAGE_KEY, crypto.randomUUID());
  } catch {
    /* Same-tab refresh still works when browser storage is unavailable. */
  }
}
