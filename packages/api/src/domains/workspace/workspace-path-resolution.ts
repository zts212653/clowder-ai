import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  listWorkspaceRootEntries,
  resolveWorkspaceFilesystemPath,
  WorkspaceSecurityError,
  type WorktreeEntry,
} from './workspace-security.js';

export interface WorkspaceDocumentTarget {
  worktreeId: string;
  path: string;
  line: number | null;
}

export interface WorkspaceAbsolutePathTarget {
  worktreeId: string;
  path: string;
  kind: 'file' | 'directory';
}

const MARKDOWN_DOCUMENT_HREF_RE = /^(.*\.mdx?)(?::([1-9]\d*))?$/i;

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function selectWorkspaceRoot(
  absoluteCandidate: string,
  entries: WorktreeEntry[],
): Promise<{ entry: WorktreeEntry; relativePath: string }> {
  const withResolvedRoots = entries.map((entry) => ({
    entry,
    resolvedRoot: resolve(entry.root),
  }));
  let matches = withResolvedRoots.filter(({ resolvedRoot }) => containsPath(resolvedRoot, absoluteCandidate));
  let relativeFromMatch = (root: string) => relative(root, absoluteCandidate);

  // Root aliases such as macOS /tmp → /private/tmp may not match lexically.
  // Fall back to canonical paths only when no lexical root matched. A lexical
  // match is intentionally preferred so resolveWorkspacePath can detect a
  // symlink that escapes the chosen root.
  if (matches.length === 0) {
    const canonicalCandidate = await realpath(absoluteCandidate).catch(() => absoluteCandidate);
    const canonicalEntries = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        resolvedRoot: await realpath(entry.root).catch(() => resolve(entry.root)),
      })),
    );
    matches = canonicalEntries.filter(({ resolvedRoot }) => containsPath(resolvedRoot, canonicalCandidate));
    relativeFromMatch = (root: string) => relative(root, canonicalCandidate);
  }

  const selected = matches.sort((a, b) => b.resolvedRoot.length - a.resolvedRoot.length)[0];
  if (!selected) {
    throw new WorkspaceSecurityError('Path is not in a registered workspace', 'NOT_FOUND');
  }
  return {
    entry: selected.entry,
    relativePath: relativeFromMatch(selected.resolvedRoot),
  };
}

/** Resolve any Codex-native absolute local path to the typed Workspace target. */
export async function resolveWorkspaceAbsolutePath(
  absolutePath: string,
  repoRoot?: string,
): Promise<WorkspaceAbsolutePathTarget> {
  if (!isAbsolute(absolutePath)) {
    throw new WorkspaceSecurityError('Workspace path must be absolute', 'NOT_FOUND');
  }
  const selected = await selectWorkspaceRoot(resolve(absolutePath), await listWorkspaceRootEntries(repoRoot));
  const resolvedPath = await resolveWorkspaceFilesystemPath(selected.entry.root, selected.relativePath);
  const pathStat = await stat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new WorkspaceSecurityError('Workspace path not found', 'NOT_FOUND');
    }
    throw error;
  });
  if (!pathStat.isFile() && !pathStat.isDirectory()) {
    throw new WorkspaceSecurityError('Workspace path not found', 'NOT_FOUND');
  }
  return {
    worktreeId: selected.entry.id,
    path: selected.relativePath ? selected.relativePath.split(sep).join('/') : '.',
    kind: pathStat.isDirectory() ? 'directory' : 'file',
  };
}

/** Resolve a fragment-free native Markdown path, including an optional `:line`, to a typed target. */
export async function resolveWorkspaceDocumentHref(href: string, repoRoot?: string): Promise<WorkspaceDocumentTarget> {
  const match = href.match(MARKDOWN_DOCUMENT_HREF_RE);
  const candidate = match?.[1];
  if (!candidate) {
    throw new WorkspaceSecurityError('Document link must be an absolute local Markdown path', 'NOT_FOUND');
  }
  const target = await resolveWorkspaceAbsolutePath(candidate, repoRoot);
  if (target.kind !== 'file') {
    throw new WorkspaceSecurityError('Document not found', 'NOT_FOUND');
  }
  return {
    worktreeId: target.worktreeId,
    path: target.path,
    line: match[2] ? Number.parseInt(match[2], 10) : null,
  };
}
