import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiFetch } from '../utils/api-client';

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitStatusResult {
  branch: string;
  staged: Array<{ status: string; path: string }>;
  unstaged: Array<{ status: string; path: string }>;
  untracked: Array<{ status: string; path: string }>;
}

export interface CommitDetail {
  hash: string;
  files: Array<{ path: string; summary: string }>;
}

/** A read result pinned to the worktree it was fetched for. */
interface TargetedSnapshot<T> {
  worktreeId: string;
  value: T;
}

/**
 * F322 R3: every read is attributed to its target worktree. A failed refresh
 * clears the current target's snapshot (so a stale success can never keep
 * claiming "clean"), and a response that settles after the target changed is
 * discarded instead of overwriting the new target's state.
 */
export function useGitPanel() {
  const worktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const [commitsSnap, setCommitsSnap] = useState<TargetedSnapshot<GitCommit[]> | null>(null);
  const [statusSnap, setStatusSnap] = useState<TargetedSnapshot<GitStatusResult> | null>(null);
  const [detailSnap, setDetailSnap] = useState<TargetedSnapshot<CommitDetail> | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusErrorSnap, setStatusErrorSnap] = useState<TargetedSnapshot<string> | null>(null);
  const logEpoch = useRef(0);
  const statusEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const targetRef = useRef(worktreeId);

  useLayoutEffect(() => {
    targetRef.current = worktreeId;
  }, [worktreeId]);

  const ownsRead = (request: number, epochRef: { current: number }, target: string) =>
    request === epochRef.current && targetRef.current === target;

  const fetchLog = useCallback(
    async (limit = 50) => {
      const target = worktreeId;
      if (!target) return;
      const request = ++logEpoch.current;
      setLogLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/workspace/git-log?worktreeId=${encodeURIComponent(target)}&limit=${limit}`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (ownsRead(request, logEpoch, target)) setCommitsSnap({ worktreeId: target, value: data.commits });
      } catch (e) {
        if (ownsRead(request, logEpoch, target)) setError(e instanceof Error ? e.message : 'Failed to fetch git log');
      } finally {
        if (request === logEpoch.current) setLogLoading(false);
      }
    },
    [worktreeId],
  );

  const fetchStatus = useCallback(async () => {
    const target = worktreeId;
    if (!target) return;
    const request = ++statusEpoch.current;
    setStatusLoading(true);
    try {
      const res = await apiFetch(`/api/workspace/git-status?worktreeId=${encodeURIComponent(target)}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      if (ownsRead(request, statusEpoch, target)) {
        setStatusSnap({ worktreeId: target, value: json });
        setStatusErrorSnap(null);
      }
    } catch (e) {
      if (ownsRead(request, statusEpoch, target)) {
        const message = e instanceof Error ? e.message : 'Failed to fetch git status';
        setStatusSnap((prev) => (prev && prev.worktreeId === target ? null : prev));
        setStatusErrorSnap({ worktreeId: target, value: message });
        setError(message);
      }
    } finally {
      if (request === statusEpoch.current) setStatusLoading(false);
    }
  }, [worktreeId]);

  const fetchCommitDetail = useCallback(
    async (hash: string) => {
      const target = worktreeId;
      if (!target) return;
      const request = ++detailEpoch.current;
      setDetailSnap(null);
      try {
        const res = await apiFetch(`/api/workspace/git-show?worktreeId=${encodeURIComponent(target)}&hash=${hash}`);
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        if (ownsRead(request, detailEpoch, target)) setDetailSnap({ worktreeId: target, value: json });
      } catch (e) {
        if (ownsRead(request, detailEpoch, target))
          setError(e instanceof Error ? e.message : 'Failed to fetch commit detail');
      }
    },
    [worktreeId],
  );

  const refresh = useCallback(async () => {
    await Promise.all([fetchLog(), fetchStatus()]);
  }, [fetchLog, fetchStatus]);

  return {
    commits: commitsSnap?.worktreeId === worktreeId ? commitsSnap.value : [],
    status: statusSnap?.worktreeId === worktreeId ? statusSnap.value : null,
    commitDetail: detailSnap?.worktreeId === worktreeId ? detailSnap.value : null,
    loading: logLoading || statusLoading,
    statusLoading,
    statusError: statusErrorSnap?.worktreeId === worktreeId ? statusErrorSnap.value : null,
    error,
    fetchLog,
    fetchStatus,
    fetchCommitDetail,
    refresh,
  };
}
