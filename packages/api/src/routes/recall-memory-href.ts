/** A memory destination always carries the delivered version, independently of message provenance. */
export function recallMemoryHref(family: string, memoryId: string, revision: string, threadId: string): string {
  return `/memory?${new URLSearchParams({ family, memoryId, revision, from: threadId })}`;
}
