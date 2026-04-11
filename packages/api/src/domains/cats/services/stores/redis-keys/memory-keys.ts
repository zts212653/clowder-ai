/**
 * Redis key patterns for memory store.
 */

/** Memory hash key pattern: cat-cafe:memory:{threadId} */
export function memoryKey(threadId: string): string {
  return `cat-cafe:memory:${threadId}`;
}

/** TTL for memory entries: 30 days */
export const MEMORY_TTL_SECONDS = 0; // persistent — set >0 to enable expiry
