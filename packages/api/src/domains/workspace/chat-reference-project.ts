import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { repositoryFromRemote } from './pull-request-changes.js';
import { selectWorkspaceRoot } from './workspace-path-resolution.js';
import { resolveWorkspaceFilesystemPath, type WorktreeEntry } from './workspace-security.js';

const exec = promisify(execFile);
export type ChatProject = { entry: WorktreeEntry; directory: string };
export async function resolveChatProject(
  project: string | null,
  entries: WorktreeEntry[],
): Promise<ChatProject | null> {
  if (!project || !isAbsolute(project)) return null;
  try {
    const selected = await selectWorkspaceRoot(resolve(project), entries);
    const directory = await resolveWorkspaceFilesystemPath(selected.entry.root, selected.relativePath || '.');
    return { entry: selected.entry, directory: await realpath(directory) };
  } catch {
    return null;
  }
}
export async function chatRepository(project: ChatProject): Promise<{ root: string; repo: string | null } | null> {
  try {
    const top = await exec('git', ['-C', project.directory, 'rev-parse', '--show-toplevel'], {
      timeout: 1500,
      maxBuffer: 4096,
    });
    const root = await realpath(top.stdout.trim());
    if (root !== (await realpath(project.entry.root))) return null;
    const remote = await exec('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      timeout: 1500,
      maxBuffer: 4096,
    }).catch(() => null);
    return {
      root,
      repo: remote ? repositoryFromRemote(remote.stdout) : null,
    };
  } catch {
    return null;
  }
}
// A batch query must contain literal ref names, never Git revision expressions or extra stdin records.
function literalGitRef(value: string): boolean {
  return (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Git ref names cannot contain controls or batch record delimiters.
    !/[\x00-\x20\x7f~^:?*[\\]/u.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.') &&
    value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

async function findBlobRef(root: string, parts: string[]): Promise<string | undefined> {
  const candidates: { ref: string; query: string }[] = [];
  for (let end = parts.length - 1; end > 0; end--) {
    const ref = parts.slice(0, end).join('/');
    if (!literalGitRef(ref)) continue;
    for (const namespace of ['heads', 'tags', 'remotes/origin']) {
      candidates.push({ ref, query: `refs/${namespace}/${ref}^{commit}` });
    }
    if (end === 1 && /^[0-9a-f]{7,40}$/i.test(ref)) candidates.push({ ref, query: `${ref}^{commit}` });
  }
  if (!candidates.length) return undefined;
  const input = `${candidates.map(({ query }) => query).join('\n')}\n`;
  const lookup = exec('git', ['-C', root, 'cat-file', '--batch-check=%(objecttype)'], {
    timeout: 1500,
    // Missing answers echo their query. The response budget depends only on this URL, not repository size.
    maxBuffer: Buffer.byteLength(input) + candidates.length * 64,
  });
  const written = new Promise<void>((resolve, reject) => {
    const stdin = lookup.child.stdin;
    if (!stdin) return reject(new Error('Git ref lookup requires stdin'));
    stdin.once('error', reject);
    stdin.end(input, resolve);
  });
  const [{ stdout }] = await Promise.all([lookup, written]);
  const answers = stdout.trimEnd().split('\n');
  return candidates.find((_, index) => answers[index] === 'commit')?.ref;
}
/** A blob suffix has no delimiter between a slash branch and its repository-relative path. */
export async function chatBlobPath(reference: string, project: ChatProject): Promise<string | null> {
  try {
    const url = new URL(reference);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) return null;
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (parts[2] !== 'blob' || parts.length < 5) return null;
    const repository = await chatRepository(project);
    if (!repository || repository.repo?.toLowerCase() !== `${parts[0]}/${parts[1]}`.toLowerCase()) return null;
    const tail = parts.slice(3).join('/');
    const ref = await findBlobRef(repository.root, parts.slice(3));
    if (!ref) return null;
    const path = tail.slice(ref.length + 1);
    if (path.split('/').includes('..') || isAbsolute(path)) return null;
    const line = /^#L([1-9]\d*)(?:-L[1-9]\d*)?$/.exec(url.hash)?.[1];
    return resolve(repository.root, path) + (line ? `:${line}` : '');
  } catch {
    return null;
  }
}
