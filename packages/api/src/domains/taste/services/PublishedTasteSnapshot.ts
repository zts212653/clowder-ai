import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execGit = promisify(execFile);
const PUBLISHED_REF = 'refs/cat-cafe/taste/published';

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execGit('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function ref(root: string, name: string): Promise<string | null> {
  const refs = await git(root, ['for-each-ref', '--format=%(refname) %(objectname)', name]);
  return (
    refs
      .split('\n')
      .find((line) => line.startsWith(`${name} `))
      ?.slice(name.length + 1) ?? null
  );
}

async function ancestor(root: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

/** Retain the confirmed remote tree in the shared object database, never the working tree/index. */
export async function retainPublishedTasteSnapshot(sourceRoot: string, publishedCheckout: string): Promise<void> {
  const sha = (await git(publishedCheckout, ['rev-parse', 'HEAD'])).trim();
  await git(sourceRoot, ['fetch', '--no-tags', '--no-write-fetch-head', publishedCheckout, sha]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await ref(sourceRoot, PUBLISHED_REF);
    if (previous === sha || (previous && (await ancestor(sourceRoot, sha, previous)))) return;
    if (previous && !(await ancestor(sourceRoot, previous, sha))) {
      throw new Error('Published Taste history diverged from its retained canonical snapshot');
    }
    try {
      await git(sourceRoot, ['update-ref', PUBLISHED_REF, sha, previous ?? '']);
      return;
    } catch (error) {
      if ((await ref(sourceRoot, PUBLISHED_REF)) === previous) throw error;
    }
  }
  throw new Error('Published Taste snapshot changed during retention');
}

export interface PublishedTasteSnapshot {
  read(sourcePath: string): Promise<string | null>;
  list(): Promise<string[]>;
}

/** Pin one approved Git tree per read operation. Local main may remain dirty or diverged. */
export async function publishedTasteSnapshot(root: string): Promise<PublishedTasteSnapshot | null> {
  let sha = await ref(root, PUBLISHED_REF);
  if (!sha) return null;
  const synchronized = await ref(root, 'refs/remotes/origin/main');
  if (synchronized && (await ancestor(root, sha, synchronized))) sha = synchronized;
  const pinnedSha = sha;
  return {
    async read(sourcePath) {
      if (!/^docs\/taste\/vignettes\/[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u.test(sourcePath)) return null;
      const entry = await git(root, ['ls-tree', pinnedSha, '--', sourcePath]);
      if (!/^100(?:644|755) blob /u.test(entry)) return null;
      return git(root, ['cat-file', 'blob', `${pinnedSha}:${sourcePath}`]);
    },
    async list() {
      return (await git(root, ['ls-tree', '-r', '-z', '--name-only', pinnedSha, '--', 'docs/taste/vignettes']))
        .split('\0')
        .filter(Boolean);
    },
  };
}
