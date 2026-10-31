import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiFetch } from '../utils/api-client';

export interface StaleBranch {
  name: string;
  lastCommitDate: string;
  author: string;
  mergedInto: string;
}

export interface WorktreeHealth {
  path: string;
  branch: string;
  head: string;
  isOrphan: boolean;
}

export interface DriftCommit {
  short: string;
  subject: string;
}

export interface RuntimeDrift {
  available: boolean;
  aheadOfMain: number;
  behindMain: number;
  runtimeHead: string;
  mainHead: string;
  behindCommits: DriftCommit[];
}

export interface GitHealthResult {
  staleBranches: StaleBranch[];
  worktrees: WorktreeHealth[];
  runtimeDrift: RuntimeDrift | null;
}

interface TargetedSnapshot<T> {
  worktreeId: string;
  value: T;
}

/** F322 R3: health reads are pinned to their target worktree, like useGitPanel. */
export function useGitHealth() {
  const worktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const [healthSnap, setHealthSnap] = useState<TargetedSnapshot<GitHealthResult> | null>(null);
  const [errorSnap, setErrorSnap] = useState<TargetedSnapshot<string> | null>(null);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const targetRef = useRef(worktreeId);

  useLayoutEffect(() => {
    targetRef.current = worktreeId;
  }, [worktreeId]);

  const fetchHealth = useCallback(async () => {
    const target = worktreeId;
    if (!target) return;
    const request = ++epoch.current;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/workspace/git-health?worktreeId=${encodeURIComponent(target)}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      if (request === epoch.current && targetRef.current === target) {
        setHealthSnap({ worktreeId: target, value: json });
        setErrorSnap(null);
      }
    } catch (e) {
      if (request === epoch.current && targetRef.current === target) {
        setHealthSnap((prev) => (prev && prev.worktreeId === target ? null : prev));
        setErrorSnap({ worktreeId: target, value: e instanceof Error ? e.message : 'Failed to fetch git health' });
      }
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, [worktreeId]);

  return {
    health: healthSnap?.worktreeId === worktreeId ? healthSnap.value : null,
    loading,
    error: errorSnap?.worktreeId === worktreeId ? errorSnap.value : null,
    fetchHealth,
  };
}
