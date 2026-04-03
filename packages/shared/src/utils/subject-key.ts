/**
 * Subject key utilities (#320 KD-15).
 *
 * Standard format: `kind:value`
 *   pr:owner/repo#123
 *   thread:thread_abc123
 *   repo:owner/repo
 *   external:xyz
 */

export function prSubjectKey(repoFullName: string, prNumber: number): string {
  return `pr:${repoFullName}#${prNumber}`;
}

export function parsePrSubjectKey(key: string): { repoFullName: string; prNumber: number } | null {
  if (!key.startsWith('pr:')) return null;
  const rest = key.slice(3); // "owner/repo#123"
  const hashIdx = rest.lastIndexOf('#');
  if (hashIdx < 0) return null;
  const repoFullName = rest.slice(0, hashIdx);
  const prNumber = parseInt(rest.slice(hashIdx + 1), 10);
  if (!repoFullName || Number.isNaN(prNumber)) return null;
  return { repoFullName, prNumber };
}

export function threadSubjectKey(threadId: string): string {
  return `thread:${threadId}`;
}

export function extractSubjectKind(key: string): string | null {
  const colonIdx = key.indexOf(':');
  if (colonIdx < 0) return null;
  return key.slice(0, colonIdx);
}
