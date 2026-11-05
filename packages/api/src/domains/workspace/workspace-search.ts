import { opendir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { normalizeWorkspaceRelativePath } from '@cat-cafe/shared/utils';
import { isDenylisted, resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

const CONTENT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.css',
  '.html',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.py',
]);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'secrets']);
const MAX_CONTENT_FILE_SIZE = 10 * 1024 * 1024;

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  content: string;
  contextBefore: string;
  contextAfter: string;
}

/** Directory handles stream entries and close on completion/error; symlink entries are never followed. */
export async function* workspaceSearchFiles(root: string, directory = root): AsyncGenerator<string> {
  const name = basename(directory);
  if (directory === root && name.startsWith('.') && name !== '.') return;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
      try {
        await resolveWorkspaceFilesystemPath(root, relative(root, fullPath));
      } catch (error) {
        if (error instanceof WorkspaceSecurityError) continue;
        throw error;
      }
      // Keep the registered root's lexical coordinate (for example /var vs /private/var).
      yield* workspaceSearchFiles(root, fullPath);
    } else if (entry.isFile()) {
      if (
        entry.name.startsWith('.env') ||
        entry.name.endsWith('.pem') ||
        entry.name.endsWith('.key') ||
        entry.name.startsWith('id_rsa')
      )
        continue;
      yield fullPath;
    }
  }
}

/** Retain only the first limit+1 matches, preserving the original locale-sorted result order. */
export async function searchWorkspace(
  root: string,
  query: string,
  type: 'filename' | 'content',
  limit: number,
  files: AsyncIterable<string> = workspaceSearchFiles(root),
): Promise<{ results: WorkspaceSearchResult[]; truncated: boolean }> {
  const lowerQuery = query.toLowerCase();
  const matches: WorkspaceSearchResult[] = [];
  for await (const fullPath of files) {
    const path = normalizeWorkspaceRelativePath(relative(root, fullPath));
    if (isDenylisted(path)) continue;
    if (
      type === 'filename'
        ? !path.toLowerCase().includes(lowerQuery)
        : !CONTENT_EXTENSIONS.has(extname(path).toLowerCase())
    )
      continue;
    // Once an extra match proves truncation, later-sorting paths cannot change the response.
    if (matches.length > limit && path.localeCompare(matches.at(-1)!.path) >= 0) continue;
    let resolved: string;
    try {
      resolved = await resolveWorkspaceFilesystemPath(root, path);
    } catch (error) {
      if (error instanceof WorkspaceSecurityError) continue;
      throw error;
    }
    let match: WorkspaceSearchResult | undefined;
    if (type === 'filename') {
      match = { path, line: 0, content: '', contextBefore: '', contextAfter: '' };
    } else {
      const fileStat = await stat(resolved).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size > MAX_CONTENT_FILE_SIZE) continue;
      const text = await readFile(resolved, 'utf8').catch(() => null);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      const index = lines.findIndex((line) => line.toLowerCase().includes(lowerQuery));
      if (index < 0) continue;
      match = {
        path,
        line: index + 1,
        content: lines[index]?.trim() ?? '',
        contextBefore: lines.slice(Math.max(0, index - 2), index).join('\n'),
        contextAfter: lines.slice(index + 1, index + 3).join('\n'),
      };
    }
    matches.push(match);
    matches.sort((a, b) => a.path.localeCompare(b.path));
    if (matches.length > limit + 1) matches.pop();
  }
  return { results: matches.slice(0, limit), truncated: matches.length > limit };
}
