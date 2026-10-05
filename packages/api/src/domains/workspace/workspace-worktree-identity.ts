import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface WorkspaceIdentityEntry {
  readonly id: string;
  readonly legacyAliases?: readonly string[];
  readonly rootIdentity?: string;
  readonly root: string;
}

export interface WorkspaceContentWorktreeIdentity {
  readonly canonicalWorktreeId: string;
  readonly root: string;
}

export type ListWorkspaceIdentityEntries = (repoRoot?: string) => Promise<readonly WorkspaceIdentityEntry[]>;

// Reserved namespace: a display alias must never reinterpret a complete identity.
const DURABLE_WORKTREE_ID_PREFIX = 'f063_root_v1_';

async function canonicalRoot(root: string): Promise<string | null> {
  return realpath(root).catch(() => null);
}

export function durableIdForCanonicalRoot(root: string): string {
  return `${DURABLE_WORKTREE_ID_PREFIX}${createHash('sha256').update(root).digest('hex')}`;
}

/** A confirmed physical root must not turn a later symlink target into a new grant. */
export async function canonicalWorkspaceIdentityRoot(entry: WorkspaceIdentityEntry): Promise<string | null> {
  const root = await canonicalRoot(entry.root);
  return root && (!entry.rootIdentity || durableIdForCanonicalRoot(root) === entry.rootIdentity) ? root : null;
}

async function uniqueCanonicalRoot(
  entries: readonly WorkspaceIdentityEntry[],
  matches: (entry: WorkspaceIdentityEntry, root: string) => boolean,
): Promise<string | null> {
  const roots = new Set<string>();
  for (const entry of entries) {
    const root = await canonicalWorkspaceIdentityRoot(entry);
    if (root && matches(entry, root)) roots.add(root);
  }
  return roots.size === 1 ? [...roots][0] : null;
}

async function identityForAuthorizedRoot(
  root: string,
  entries: readonly WorkspaceIdentityEntry[],
): Promise<WorkspaceContentWorktreeIdentity | null> {
  const canonical = await canonicalRoot(root);
  if (!canonical) return null;
  const authorized = await uniqueCanonicalRoot(entries, (_, candidateRoot) => candidateRoot === canonical);
  return authorized ? { root: authorized, canonicalWorktreeId: durableIdForCanonicalRoot(authorized) } : null;
}

/**
 * A legacy scope prefix only selects candidates; it is not an identity proof.
 * Every matching repository/worktree must remain verifiable.
 */
export async function resolveVerifiedScopedWorktreeAlias(
  worktreeId: string,
  repoRoot: string,
  listWorktrees: ListWorkspaceIdentityEntries,
): Promise<string | null> {
  const candidates = new Set([repoRoot, resolve(repoRoot)]);
  const resolvedRoot = await canonicalRoot(repoRoot);
  if (!resolvedRoot) throw new Error('Legacy workspace scope cannot be verified');
  candidates.add(resolvedRoot);
  const matches = new Set<string>();

  for (const candidate of candidates) {
    const prefix = `${createHash('sha256').update(candidate).digest('hex').slice(0, 6)}_`;
    if (!worktreeId.startsWith(prefix)) continue;
    const canonicalId = worktreeId.slice(prefix.length);
    if (!canonicalId || canonicalId.length > 256) continue;
    const entries = (await listWorktrees(candidate)).filter((candidateEntry) => candidateEntry.id === canonicalId);
    for (const entry of entries) {
      const root = await canonicalWorkspaceIdentityRoot(entry);
      if (!root) throw new Error('Legacy workspace candidate cannot be verified');
      matches.add(root);
    }
  }
  if (matches.size > 1) throw new Error('Legacy workspace scope is ambiguous');
  return [...matches][0] ?? null;
}

export async function resolveVerifiedScopedWorktreeAliasAtAuthorizedEntries(
  worktreeId: string,
  scopeRoots: readonly (string | undefined)[],
  authorizedEntries: readonly WorkspaceIdentityEntry[],
  listWorktrees: ListWorkspaceIdentityEntries,
): Promise<string | null> {
  if (!/^[a-f0-9]{6}_.{1,256}$/.test(worktreeId)) return null;
  const authorizedRoots = new Set<string>();
  for (const entry of authorizedEntries) {
    const root = await canonicalWorkspaceIdentityRoot(entry);
    // Unlike full root identities, short legacy prefixes can collide. An
    // unresolved registered candidate must not manufacture a unique survivor.
    if (!root) return null;
    authorizedRoots.add(root);
  }
  const matches = new Set<string>();
  for (const root of scopeRoots) {
    if (!root) continue;
    const recovered = await resolveVerifiedScopedWorktreeAlias(worktreeId, root, listWorktrees);
    const canonical = recovered ? await canonicalRoot(recovered) : null;
    if (canonical && authorizedRoots.has(canonical)) matches.add(canonical);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/**
 * Recovers deterministic pre-stable F309 aliases without guessing a root from
 * alias text. Configured Git inventories and exact linked roots stay distinct:
 * repository membership alone is insufficient without an authorized entry.
 */
export async function resolveVerifiedScopedWorkspaceAlias(input: {
  readonly configuredRoot?: string;
  readonly currentEntries: readonly WorkspaceIdentityEntry[];
  readonly linkedEntries: readonly WorkspaceIdentityEntry[];
  readonly listWorktrees: ListWorkspaceIdentityEntries;
  readonly worktreeId: string;
}): Promise<string | null> {
  const configuredEntries = input.configuredRoot ? await input.listWorktrees(input.configuredRoot) : undefined;
  const primaryEntries = configuredEntries ?? input.currentEntries;
  const authorizedEntries = [...primaryEntries, ...input.linkedEntries];
  const scopeRoots = input.configuredRoot
    ? [
        input.configuredRoot,
        ...primaryEntries.map((entry) => entry.root),
        ...input.linkedEntries.map((entry) => entry.root),
      ]
    : input.linkedEntries.map((entry) => entry.root);
  return resolveVerifiedScopedWorktreeAliasAtAuthorizedEntries(
    input.worktreeId,
    scopeRoots,
    authorizedEntries,
    input.listWorktrees,
  );
}

/**
 * Resolves only from F063's authorized inventory. With an explicit configured
 * root, the process checkout is deliberately excluded; it is only the
 * development fallback when no root has been configured.
 */
export async function resolveAuthorizedWorkspaceContentWorktree(input: {
  readonly configuredEntries?: readonly WorkspaceIdentityEntry[];
  readonly currentEntries: readonly WorkspaceIdentityEntry[];
  readonly legacyRoots: readonly (string | undefined)[];
  readonly linkedEntries: readonly WorkspaceIdentityEntry[];
  readonly listWorktrees: ListWorkspaceIdentityEntries;
  readonly worktreeId: string;
}): Promise<WorkspaceContentWorktreeIdentity | null> {
  const primaryEntries = input.configuredEntries ?? input.currentEntries;
  const authorizedEntries = [...primaryEntries, ...input.linkedEntries];
  if (input.worktreeId.startsWith(DURABLE_WORKTREE_ID_PREFIX)) {
    const root = await uniqueCanonicalRoot(
      authorizedEntries,
      (_, candidate) => durableIdForCanonicalRoot(candidate) === input.worktreeId,
    );
    return root ? identityForAuthorizedRoot(root, authorizedEntries) : null;
  }
  const directEntries = authorizedEntries.filter(
    (entry) => entry.id === input.worktreeId || entry.legacyAliases?.includes(input.worktreeId),
  );
  if (directEntries.length > 0) {
    // A UI alias is not a root identity: every possible match must be resolved.
    // ENOENT/EACCES/ELOOP cannot turn two possible roots into one surviving grant.
    const resolved = await Promise.all(directEntries.map(canonicalWorkspaceIdentityRoot));
    if (resolved.some((root) => root === null)) return null;
    const roots = new Set(resolved);
    const root = roots.size === 1 ? [...roots][0] : null;
    return root ? identityForAuthorizedRoot(root, authorizedEntries) : null;
  }

  const legacyRoot = await resolveVerifiedScopedWorktreeAliasAtAuthorizedEntries(
    input.worktreeId,
    input.legacyRoots,
    authorizedEntries,
    input.listWorktrees,
  );
  return legacyRoot ? identityForAuthorizedRoot(legacyRoot, authorizedEntries) : null;
}
