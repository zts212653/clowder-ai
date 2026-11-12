import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readGitBlobs } from '../../memory/published-git-source.js';

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
  revision?: string;
  entries?(): Promise<Map<string, string>>;
  prefetch?(sourcePaths: readonly string[]): Promise<void>;
  read(sourcePath: string): Promise<string | null>;
  list(): Promise<string[]>;
}

/**
 * Pin one approved Git tree per read operation. Local main may remain dirty or diverged.
 * Existing published repos without a retained publication ref use origin/main for every
 * consumer (readers, browse and projection writers), rather than dirty local canonical files.
 */
export async function publishedTasteSnapshot(root: string): Promise<PublishedTasteSnapshot | null> {
  const synchronized = await ref(root, 'refs/remotes/origin/main');
  let sha = (await ref(root, PUBLISHED_REF)) ?? synchronized;
  if (!sha) return null;
  if (synchronized && (await ancestor(root, sha, synchronized))) sha = synchronized;
  const pinnedSha = sha;
  let index: Promise<Map<string, string>> | undefined;
  const contents = new Map<string, string | null>();
  const oversized = new Set<string>();
  const entries = () => {
    index ??= git(root, ['ls-tree', '--full-tree', '--long', '-r', '-z', pinnedSha, '--', 'docs/taste/vignettes']).then(
      (tree) => {
        const files = new Map<string, string>();
        for (const row of tree.split('\0')) {
          const match =
            /^100(?:644|755) blob ([a-f0-9]+) +(\d+)\t(docs\/taste\/vignettes\/[\p{L}\p{N}][\p{L}\p{N}._-]*\.md)$/u.exec(
              row,
            );
          if (match) {
            files.set(match[3], match[1]);
            if (Number(match[2]) > 1024 * 1024) oversized.add(match[3]);
          }
        }
        return files;
      },
    );
    return index;
  };
  const prefetch = async (sourcePaths: readonly string[]) => {
    const files = await entries();
    const missing: Array<[string, string]> = [];
    for (const path of new Set(sourcePaths)) {
      const oid = files.get(path);
      if (oversized.has(path)) contents.set(path, null);
      else if (oid && !contents.has(path)) missing.push([path, oid]);
    }
    for await (const [path, content] of readGitBlobs(root, missing)) {
      // Preserve the former per-file Git output budget; never cache private working files.
      contents.set(path, Buffer.byteLength(content, 'utf8') <= 1024 * 1024 ? content : null);
    }
  };
  return {
    revision: pinnedSha,
    async entries() {
      return new Map(await entries());
    },
    prefetch,
    async read(sourcePath) {
      await prefetch([sourcePath]);
      return contents.get(sourcePath) ?? null;
    },
    async list() {
      return [...(await entries()).keys()];
    },
  };
}
