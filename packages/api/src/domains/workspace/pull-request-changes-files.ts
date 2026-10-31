import type { PullRequestChangesData } from '@cat-cafe/shared';
import { isDenylisted } from './workspace-security.js';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const statuses: Record<string, string> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'A',
  changed: 'M',
  unchanged: 'M',
};

function relativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f"\\]/.test(value) &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '.' || part === '..' || !part)
  );
}

/** GitHub's file patch is hunk text. Headers are produced only from validated file identities. */
function completePatch(patch: string): boolean {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldRemaining = 0;
  let newRemaining = 0;
  let hasHunk = false;
  let complete = true;
  for (const line of lines) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (oldRemaining !== 0 || newRemaining !== 0) complete = false;
      oldRemaining = Number(header[1] ?? 1);
      newRemaining = Number(header[2] ?? 1);
      if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining))
        throw new Error('Invalid hunk count');
      hasHunk = true;
    } else if (!hasHunk) throw new Error('Missing hunk');
    else if (line === '\\ No newline at end of file') continue;
    else if (line.startsWith('+')) newRemaining--;
    else if (line.startsWith('-')) oldRemaining--;
    else if (line.startsWith(' ')) {
      oldRemaining--;
      newRemaining--;
    } else throw new Error('Invalid hunk line');
    if (oldRemaining < 0 || newRemaining < 0) throw new Error('Invalid hunk count');
  }
  return hasHunk && complete && oldRemaining === 0 && newRemaining === 0;
}

export function readPullRequestFiles(
  value: unknown,
  totalChangedFiles: number,
): Pick<PullRequestChangesData, 'changedFiles' | 'diff' | 'completeness' | 'omissions' | 'totalChangedFiles'> {
  if (!Array.isArray(value) || value.length > 300 || value.length > totalChangedFiles)
    throw new Error('Invalid comparison files');
  const changedFiles: PullRequestChangesData['changedFiles'] = [];
  const omissions = new Set<PullRequestChangesData['omissions'][number]>();
  const seen = new Set<string>();
  const patches: string[] = [];
  let bytes = 0;
  if (value.length < totalChangedFiles) omissions.add('file_limit');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid file');
    const file = item as Record<string, unknown>;
    if (
      !relativePath(file.filename) ||
      typeof file.status !== 'string' ||
      !statuses[file.status] ||
      (file.status === 'renamed' && !relativePath(file.previous_filename)) ||
      (file.previous_filename !== undefined && !relativePath(file.previous_filename)) ||
      seen.has(file.filename)
    ) {
      throw new Error('Invalid file identity');
    }
    seen.add(file.filename);
    if (
      isDenylisted(file.filename) ||
      (typeof file.previous_filename === 'string' && isDenylisted(file.previous_filename))
    ) {
      omissions.add('filtered_paths');
      continue;
    }
    let patchState: 'available' | 'unavailable' = 'unavailable';
    if (typeof file.patch === 'string' && file.patch.length > 0) {
      const patchComplete = completePatch(file.patch);
      const oldPath = typeof file.previous_filename === 'string' ? file.previous_filename : file.filename;
      const oldHeader = file.status === 'added' ? '/dev/null' : `a/${oldPath}`;
      const newHeader = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
      const diff = `diff --git a/${oldPath} b/${file.filename}\n--- ${oldHeader}\n+++ ${newHeader}\n${file.patch}\n`;
      const patchBytes = Buffer.byteLength(diff, 'utf8');
      if (!patchComplete) omissions.add('missing_patch');
      else if (bytes + patchBytes <= OUTPUT_LIMIT) {
        patches.push(diff);
        bytes += patchBytes;
        patchState = 'available';
      } else omissions.add('patch_limit');
    } else if (file.patch !== undefined && file.patch !== null && typeof file.patch !== 'string')
      throw new Error('Invalid patch value');
    if (file.patch === undefined || file.patch === null || file.patch === '') omissions.add('missing_patch');
    changedFiles.push({
      path: file.filename,
      status: statuses[file.status] ?? 'M',
      ...(typeof file.previous_filename === 'string' ? { previousPath: file.previous_filename } : {}),
      patchState,
    });
  }
  return {
    changedFiles,
    diff: patches.join(''),
    totalChangedFiles,
    omissions: [...omissions],
    completeness: omissions.size ? 'partial' : 'complete',
  };
}
