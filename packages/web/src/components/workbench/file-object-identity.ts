/** The file object is path-specific; its F063 owner remains the descriptor's existing root. */
export function fileObjectIdentity(worktreeId: string, path: string): string {
  return encodeURIComponent(JSON.stringify([worktreeId, path]));
}

export function matchesFileObjectIdentity(id: string, worktreeId: string, path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(id));
    return (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === worktreeId &&
      parsed[1] === path &&
      id === fileObjectIdentity(worktreeId, path)
    );
  } catch {
    return false;
  }
}
