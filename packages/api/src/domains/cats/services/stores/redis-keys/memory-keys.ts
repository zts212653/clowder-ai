/**
 * Redis key patterns for memory store.
 */

/** Memory hash key pattern: cat-cafe:memory:{threadId} */
export function memoryKey(threadId: string): string {
  return `cat-cafe:memory:${threadId}`;
}
