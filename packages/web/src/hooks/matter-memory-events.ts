export const MATTER_MEMORY_CHANGED = 'cat-cafe:memory-matter-changed';
export function notifyMatterMemoryChanged(): void {
  window.dispatchEvent(new Event(MATTER_MEMORY_CHANGED));
}
