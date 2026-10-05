import {
  type ListWorkspaceIdentityEntries,
  resolveAuthorizedWorkspaceContentWorktree,
} from '../workspace-worktree-identity.js';

/** One authoritative inventory rule for F063's content and native-file readers. */
export async function resolveCurrentWorkspaceContentRoot(
  worktreeId: string,
  listWorktrees: ListWorkspaceIdentityEntries,
  getLinkedRoots: ListWorkspaceIdentityEntries,
) {
  const configuredRoot = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  const [currentEntries, linkedEntries, configuredEntries] = await Promise.all([
    configuredRoot ? Promise.resolve([]) : listWorktrees(),
    getLinkedRoots(),
    configuredRoot ? listWorktrees(configuredRoot) : Promise.resolve(undefined),
  ]);
  const primaryEntries = configuredEntries ?? currentEntries;
  return resolveAuthorizedWorkspaceContentWorktree({
    worktreeId,
    currentEntries,
    configuredEntries,
    linkedEntries,
    legacyRoots: [
      configuredRoot ?? process.cwd(),
      ...primaryEntries.map((entry) => entry.root),
      ...linkedEntries.map((entry) => entry.root),
    ],
    listWorktrees,
  });
}
