import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type ChatReferenceTarget,
  isChatCommitCandidate,
  isChatPathCandidate,
  isExplicitChatPathReference,
  parseChatGitHubUrl,
  parseLegacyChatPathReference,
} from '@cat-cafe/shared';
import type { createChatGitHubReader } from './chat-github-references.js';
import { chatBlobPath, chatRepository, resolveChatProject } from './chat-reference-project.js';
import { readWorkspaceFileMetadata } from './workspace-file-metadata.js';
import { resolveWorkspacePathLinkHref, WorkspacePathNotFoundError } from './workspace-path-resolution.js';
import { getWorktreeRoot, resolveWorkspaceFilesystemPath, type WorktreeEntry } from './workspace-security.js';

const exec = promisify(execFile);
export async function readChatReference(
  input: string,
  project: string | null,
  entries: WorktreeEntry[],
  github: ReturnType<typeof createChatGitHubReader>,
): Promise<ChatReferenceTarget | null> {
  const { reference, worktreeId: historicalId } = parseLegacyChatPathReference(input);
  const historical = historicalId ? entries.find((entry) => entry.id === historicalId) : undefined;
  if (historicalId && !historical) return null;
  const coordinate = await resolveChatProject(historical?.root ?? project, entries);
  const githubRef = parseChatGitHubUrl(reference);
  if (githubRef) {
    const result = await github(reference);
    if (!result) return result;
    if (result.objectType === 'pull') return { ...result, worktreeId: (coordinate?.entry ?? entries[0])?.id };
    return result;
  }
  if (isChatCommitCandidate(reference)) {
    if (!coordinate) return null;
    const repository = await chatRepository(coordinate);
    if (!repository) return null;
    try {
      const { stdout } = await exec(
        'git',
        ['-C', repository.root, 'show', '-s', '--format=%H%n%s', `${reference}^{commit}`, '--'],
        { timeout: 1500, maxBuffer: 8192 },
      );
      const [sha, title] = stdout.trimEnd().split('\n');
      return /^[0-9a-f]{40}$/.test(sha)
        ? { kind: 'commit', sha, title: title ?? '', worktreeId: coordinate.entry.id }
        : null;
    } catch {
      return null;
    }
  }
  const blob = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//.test(reference);
  let candidate = blob && coordinate ? await chatBlobPath(reference, coordinate) : reference;
  if ((blob && !coordinate) || !candidate || !isChatPathCandidate(candidate)) return null;
  if (candidate.startsWith('~/')) candidate = resolve(homedir(), candidate.slice(2));
  const relativeCandidate = !isAbsolute(candidate);
  const scopedEntries = relativeCandidate || historical ? (coordinate ? [coordinate.entry] : []) : entries;
  if (relativeCandidate) {
    if (!coordinate) return null;
    candidate = resolve(coordinate.directory, candidate);
  }
  try {
    const target = await resolveWorkspacePathLinkHref(candidate, undefined, scopedEntries);
    const declared = scopedEntries.find((entry) => entry.id === target.worktreeId);
    const root = await getWorktreeRoot(target.worktreeId);
    if (!declared || (await realpath(root)) !== (await realpath(declared.root))) return null;
    if (historical && (await realpath(root)) !== (await realpath(historical.root))) return null;
    const absolutePath = await resolveWorkspaceFilesystemPath(root, target.path);
    return {
      ...target,
      kind: 'file',
      entryType: target.kind,
      absolutePath,
      ...(await readWorkspaceFileMetadata(absolutePath)),
    };
  } catch (error) {
    return error instanceof WorkspacePathNotFoundError && !blob && isExplicitChatPathReference(reference)
      ? { kind: 'missing' }
      : null;
  }
}
