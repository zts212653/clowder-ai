'use client';

import {
  encodePullRequestChangesTarget,
  type PullRequestChangesData,
  type PullRequestChangesTarget,
  parsePullRequestChangesTarget,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CommitChangesTarget } from '../workbench/commit-changes-surface';

export interface ChangedFile {
  status: string;
  path: string;
}

export interface ChangesDiffData {
  changedFiles: ChangedFile[];
  diff: string;
  target?: PullRequestChangesTarget;
  comparison?: PullRequestChangesData['comparison'];
  completeness?: PullRequestChangesData['completeness'];
  omissions?: PullRequestChangesData['omissions'];
  totalChangedFiles?: number;
}

/** Stable error keys; each presentation maps them to its own copy. */
export type ChangesDiffError =
  | 'fetch_failed'
  | 'network'
  | 'authentication_required'
  | 'permission_denied'
  | 'identity_required'
  | 'rate_limited'
  | 'not_found'
  | 'unavailable'
  | 'root_unavailable'
  | 'repository_mismatch'
  | 'invalid_target';

function matchesPullRequestResponse(value: unknown, key: string): value is PullRequestChangesData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<PullRequestChangesData>;
  const target = parsePullRequestChangesTarget(data.target);
  return Boolean(
    target &&
      encodePullRequestChangesTarget(target) === key &&
      typeof data.diff === 'string' &&
      Array.isArray(data.changedFiles) &&
      data.changedFiles.every((file) => file && typeof file.path === 'string' && typeof file.status === 'string') &&
      data.comparison &&
      !Array.isArray(data.comparison) &&
      Object.keys(data.comparison).length === 3 &&
      [data.comparison.baseSha, data.comparison.headSha, data.comparison.mergeBaseSha].every(
        (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha),
      ) &&
      (data.completeness === 'complete' || data.completeness === 'partial') &&
      Array.isArray(data.omissions) &&
      data.omissions.every((reason) => typeof reason === 'string' && prOmissions.has(reason)) &&
      typeof data.totalChangedFiles === 'number' &&
      Number.isSafeInteger(data.totalChangedFiles) &&
      data.totalChangedFiles >= data.changedFiles.length,
  );
}

const prOmissions = new Set(['filtered_paths', 'file_limit', 'missing_patch', 'patch_limit']);

const prErrors = new Set<ChangesDiffError>([
  'authentication_required',
  'permission_denied',
  'identity_required',
  'rate_limited',
  'not_found',
  'unavailable',
  'root_unavailable',
  'repository_mismatch',
  'invalid_target',
]);

function responseError(value: unknown): ChangesDiffError {
  if (!value || typeof value !== 'object') return 'unavailable';
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return 'unavailable';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && prErrors.has(code as ChangesDiffError)
    ? (code as ChangesDiffError)
    : 'unavailable';
}

async function readChangesResponse(
  response: Response,
  prKey: string | null,
): Promise<{ data: ChangesDiffData | null; error: ChangesDiffError | null }> {
  if (!response.ok) {
    const body: unknown = prKey ? await response.json().catch(() => null) : null;
    return { data: null, error: prKey ? responseError(body) : 'fetch_failed' };
  }
  const data: unknown = await response.json();
  if (prKey && !matchesPullRequestResponse(data, prKey)) return { data: null, error: 'unavailable' };
  return { data: data as ChangesDiffData, error: null };
}

export function useChangesDiff(
  worktreeId: string | null,
  pullRequestTarget?: PullRequestChangesTarget,
  chatSource = false,
  commitTarget?: CommitChangesTarget,
) {
  const prKey = pullRequestTarget ? encodePullRequestChangesTarget(pullRequestTarget) : null;
  const commitKey = commitTarget ? JSON.stringify(commitTarget) : null;
  const targetKey = commitKey ? `commit:${commitKey}` : prKey ? `pr:${prKey}` : `local:${worktreeId ?? ''}`;
  const currentKey = useRef(targetKey);
  currentKey.current = targetKey;
  const requestSeq = useRef(0);
  const [stored, setStored] = useState<{ key: string; data: ChangesDiffData | null } | null>(null);
  const [status, setStatus] = useState<{ key: string; loading: boolean; error: ChangesDiffError | null }>({
    key: targetKey,
    loading: Boolean(worktreeId),
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!worktreeId) return;
    const sequence = ++requestSeq.current;
    const isCurrent = () => sequence === requestSeq.current && currentKey.current === targetKey;
    setStored(null);
    setStatus({ key: targetKey, loading: true, error: null });
    try {
      const res = await apiFetch(
        commitKey
          ? `/api/workspace/chat-commit-changes?${new URLSearchParams(JSON.parse(commitKey))}`
          : prKey
            ? `/api/workspace/${chatSource ? 'chat-pull-request-changes' : 'pull-request-changes'}?target=${encodeURIComponent(prKey)}`
            : `/api/workspace/diff?worktreeId=${encodeURIComponent(worktreeId)}`,
      );
      if (!isCurrent()) return;
      if (commitKey && res.ok) {
        const value: unknown = await res.clone().json();
        const expected = JSON.parse(commitKey) as CommitChangesTarget;
        if (
          !value ||
          typeof value !== 'object' ||
          !('sha' in value) ||
          value.sha !== expected.sha ||
          !('worktreeId' in value) ||
          value.worktreeId !== expected.worktreeId
        )
          throw new Error('Commit identity mismatch');
      }
      const result = await readChangesResponse(res, prKey);
      if (!isCurrent()) return;
      setStored({ key: targetKey, data: result.data });
      setStatus({ key: targetKey, loading: false, error: result.error });
    } catch {
      if (isCurrent()) setStatus({ key: targetKey, loading: false, error: 'network' });
    }
  }, [worktreeId, prKey, targetKey, chatSource, commitKey]);

  useEffect(() => {
    void refresh();
    return () => {
      requestSeq.current++;
    };
  }, [refresh]);

  return {
    data: stored?.key === targetKey ? stored.data : null,
    loading: status.key === targetKey ? status.loading : Boolean(worktreeId),
    error: status.key === targetKey ? status.error : null,
    refresh,
    targetKey,
  };
}
