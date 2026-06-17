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
  const suffix = rest.slice(hashIdx + 1);
  // Cloud R12 P2: require strictly all-digit suffix so "123abc" is rejected.
  // parseInt("123abc") === 123 (not NaN), but the projector regex requires /^\d+$/;
  // accepting partially-numeric keys leaves unprojectable events in the event log.
  if (!repoFullName || !/^\d+$/.test(suffix)) return null;
  return { repoFullName, prNumber: parseInt(suffix, 10) };
}

/** F202 Phase 2D: issue tracking subject key */
export function issueSubjectKey(repoFullName: string, issueNumber: number): string {
  return `issue:${repoFullName}#${issueNumber}`;
}

export function parseIssueSubjectKey(key: string): { repoFullName: string; issueNumber: number } | null {
  if (!key.startsWith('issue:')) return null;
  const rest = key.slice(6); // "owner/repo#42"
  const hashIdx = rest.lastIndexOf('#');
  if (hashIdx < 0) return null;
  const repoFullName = rest.slice(0, hashIdx);
  const suffix = rest.slice(hashIdx + 1);
  // Cloud R12 P2: require strictly all-digit suffix so "123abc" is rejected.
  // parseInt("123abc") === 123 (not NaN), but the projector regex requires /^\d+$/;
  // accepting partially-numeric keys leaves unprojectable events in the event log.
  if (!repoFullName || !/^\d+$/.test(suffix)) return null;
  return { repoFullName, issueNumber: parseInt(suffix, 10) };
}

export function threadSubjectKey(threadId: string): string {
  return `thread:${threadId}`;
}

export function extractSubjectKind(key: string): string | null {
  const colonIdx = key.indexOf(':');
  if (colonIdx < 0) return null;
  return key.slice(0, colonIdx);
}
