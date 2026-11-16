import { runGitStatusCommand } from './git-status-command.js';

export { GitStatusReadError } from './git-status-command.js';

export interface GitStatusEntry {
  /** Keep both index/worktree columns, including leading spaces. */
  status: string;
  path: string;
}

/** Incremental porcelain-v1 -z framing: rename destination first, source second. */
export function createGitStatusParser(onEntry: (entry: GitStatusEntry) => void) {
  let pending = '';
  let sourcePathPending = false;
  return {
    write(chunk: string): void {
      pending += chunk;
      let start = 0;
      let end: number;
      while ((end = pending.indexOf('\0', start)) !== -1) {
        const record = pending.slice(start, end);
        start = end + 1;
        if (sourcePathPending) {
          sourcePathPending = false;
          continue;
        }
        if (record.length < 4 || record[2] !== ' ') throw new Error('Malformed Git status record');
        const status = record.slice(0, 2);
        sourcePathPending = /[RC]/.test(status);
        onEntry({ status, path: record.slice(3) });
      }
      pending = pending.slice(start);
    },
    finish(): void {
      if (pending || sourcePathPending) throw new Error('Incomplete Git status output');
    },
  };
}

/** Match porcelain order even when directory expansion arrives after top-level files. */
export function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  return (
    Number(a.status === '??') - Number(b.status === '??') || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  );
}

/** Let Git reuse its untracked cache, then expand only the directories it reports. */
export async function readGitStatus(root: string, onEntry: (entry: GitStatusEntry) => void): Promise<void> {
  const startedAt = performance.now();
  const directories: string[] = [];
  const statusArgs = ['status', '--porcelain=v1', '-z'];
  await runGitStatusCommand(root, [...statusArgs, '--untracked-files=normal'], {
    startedAt,
    phase: 'status',
    parser: createGitStatusParser((entry) => {
      if (entry.status === '??' && entry.path.endsWith('/')) directories.push(entry.path);
      else onEntry(entry);
    }),
  });

  // Bound argv bytes, not results. Leave room for up to 2x Windows argument quoting
  // below CreateProcessW's 32767-character limit; every batch shares the same deadline.
  const expansionArgs = ['--no-optional-locks', ...statusArgs, '--untracked-files=all', '--'];
  const fixedBytes = expansionArgs.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0);
  let batch: string[] = [];
  let bytes = fixedBytes;
  const expand = async () => {
    // Scoped status also sees files staged between discovery and expansion. Entries ending
    // in '/' here are nested repositories, which must remain opaque rather than recurse.
    await runGitStatusCommand(root, [...expansionArgs, ...batch], {
      startedAt,
      phase: 'untracked-expansion',
      parser: createGitStatusParser(onEntry),
    });
  };
  for (const directory of directories) {
    // Porcelain paths are repository-relative, even when root is a linked subdirectory.
    const pathspec = `:(top,literal)${directory}`;
    const size = Buffer.byteLength(pathspec) + 1;
    if (batch.length && bytes + size > 16000) {
      await expand();
      batch = [];
      bytes = fixedBytes;
    }
    batch.push(pathspec);
    bytes += size;
  }
  if (batch.length) await expand();
}
