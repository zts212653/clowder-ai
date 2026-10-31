import { prSubjectKey } from './subject-key.js';

export interface PullRequestChangesTarget {
  kind: 'github-pr';
  v: 1;
  repoFullName: string;
  prNumber: number;
  worktreeId: string;
  threadId: string | null;
}

export interface PullRequestChangesData {
  target: PullRequestChangesTarget;
  comparison: { baseSha: string; headSha: string; mergeBaseSha: string };
  changedFiles: { path: string; status: string; previousPath?: string; patchState: 'available' | 'unavailable' }[];
  diff: string;
  totalChangedFiles: number;
  completeness: 'complete' | 'partial';
  omissions: ('filtered_paths' | 'file_limit' | 'missing_patch' | 'patch_limit')[];
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/;
function repository(value: string): boolean {
  const name = value.split('/')[1];
  return REPOSITORY.test(value) && name !== '.' && name !== '..';
}
const coordinate = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

export function parsePullRequestFullRef(ref: unknown): { repoFullName: string; prNumber: number } | null {
  if (typeof ref !== 'string') return null;
  const match = /^([^#]+)#([1-9]\d*)$/.exec(ref);
  if (!match || !repository(match[1] ?? '')) return null;
  const prNumber = Number(match[2]);
  if (!Number.isSafeInteger(prNumber)) return null;
  return { repoFullName: (match[1] ?? '').toLowerCase(), prNumber };
}

export function parsePullRequestChangesTarget(value: unknown): PullRequestChangesTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (Object.keys(target).length !== 6 || target.kind !== 'github-pr' || target.v !== 1) return null;
  if (
    typeof target.repoFullName !== 'string' ||
    !repository(target.repoFullName) ||
    target.repoFullName !== target.repoFullName.toLowerCase()
  )
    return null;
  if (typeof target.prNumber !== 'number' || !Number.isSafeInteger(target.prNumber) || target.prNumber < 1) return null;
  if (
    !coordinate(target.worktreeId) ||
    (target.threadId !== null && (!coordinate(target.threadId) || target.threadId.length > 256))
  )
    return null;
  return {
    kind: 'github-pr',
    v: 1,
    repoFullName: target.repoFullName,
    prNumber: target.prNumber,
    worktreeId: target.worktreeId,
    threadId: target.threadId,
  };
}

export function encodePullRequestChangesTarget(target: PullRequestChangesTarget): string {
  if (!parsePullRequestChangesTarget(target)) throw new TypeError('Invalid PR Changes target');
  return encodeURIComponent(
    JSON.stringify([target.kind, target.v, target.repoFullName, target.prNumber, target.worktreeId, target.threadId]),
  );
}

export function decodePullRequestChangesTarget(key: string): PullRequestChangesTarget | null {
  try {
    const tuple: unknown = JSON.parse(decodeURIComponent(key));
    if (!Array.isArray(tuple) || tuple.length !== 6) return null;
    const target = parsePullRequestChangesTarget({
      kind: tuple[0],
      v: tuple[1],
      repoFullName: tuple[2],
      prNumber: tuple[3],
      worktreeId: tuple[4],
      threadId: tuple[5],
    });
    return target && encodePullRequestChangesTarget(target) === key ? target : null;
  } catch {
    return null;
  }
}

/** Content identity plus its existing root-admission coordinate; host thread is not identity. */
export function pullRequestChangesObjectId(target: PullRequestChangesTarget): string {
  return `surface:changes:pr:${encodeURIComponent(JSON.stringify([prSubjectKey(target.repoFullName, target.prNumber), target.worktreeId]))}`;
}
