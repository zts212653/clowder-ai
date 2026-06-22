export type WorktreeAliasMap = Record<string, string>;

export interface WorktreeAliasEntry {
  id: string;
  canonicalId?: string | null;
}

const EMPTY_ALIASES: WorktreeAliasMap = {};

export function buildWorktreeAliasMap(worktrees: readonly WorktreeAliasEntry[]): WorktreeAliasMap {
  const aliases: WorktreeAliasMap = {};
  for (const worktree of worktrees) {
    if (worktree.canonicalId && worktree.canonicalId !== worktree.id) {
      aliases[worktree.id] = worktree.canonicalId;
    }
  }
  return aliases;
}

export function canonicalWorktreeAlias(
  id: string | null | undefined,
  aliases: WorktreeAliasMap = EMPTY_ALIASES,
): string | null {
  if (!id) return null;
  return aliases[id] ?? id;
}

export function areWorktreeIdsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
  aliases: WorktreeAliasMap = EMPTY_ALIASES,
): boolean {
  if (!left || !right) return left === right;
  return left === right || canonicalWorktreeAlias(left, aliases) === canonicalWorktreeAlias(right, aliases);
}

export function hasEquivalentWorktreeId(
  worktrees: readonly WorktreeAliasEntry[],
  id: string | null | undefined,
  aliases?: WorktreeAliasMap,
): boolean {
  if (!id) return false;
  const effectiveAliases = aliases ?? buildWorktreeAliasMap(worktrees);
  return worktrees.some((worktree) => areWorktreeIdsEquivalent(worktree.id, id, effectiveAliases));
}

export function resolveListedWorktreeId(
  worktrees: readonly WorktreeAliasEntry[],
  id: string | null | undefined,
  aliases?: WorktreeAliasMap,
): string | null {
  if (!id) return null;
  const exactMatch = worktrees.find((worktree) => worktree.id === id);
  if (exactMatch) return exactMatch.id;

  const effectiveAliases = aliases ?? buildWorktreeAliasMap(worktrees);
  return worktrees.find((worktree) => areWorktreeIdsEquivalent(worktree.id, id, effectiveAliases))?.id ?? null;
}

export function scopeWorktreeAliases(
  aliases: WorktreeAliasMap,
  aliasProjectPath: string | null | undefined,
  currentProjectPath: string,
): WorktreeAliasMap {
  return aliasProjectPath && aliasProjectPath === currentProjectPath ? aliases : EMPTY_ALIASES;
}

export function resolveNavigateTargetWorktreeId(
  currentWorktreeId: string | null,
  targetWorktreeId: string | null | undefined,
  aliases: WorktreeAliasMap = EMPTY_ALIASES,
): string | null | undefined {
  if (currentWorktreeId && targetWorktreeId && areWorktreeIdsEquivalent(currentWorktreeId, targetWorktreeId, aliases)) {
    return currentWorktreeId;
  }
  return targetWorktreeId;
}

export function getNavigateWorktreeRoomIds(
  worktreeId: string | null,
  aliases: WorktreeAliasMap = EMPTY_ALIASES,
): string[] {
  if (!worktreeId) return [];
  const canonical = canonicalWorktreeAlias(worktreeId, aliases);
  return canonical && canonical !== worktreeId ? [worktreeId, canonical] : [worktreeId];
}
