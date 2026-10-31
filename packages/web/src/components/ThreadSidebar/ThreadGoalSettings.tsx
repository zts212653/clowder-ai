'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ThreadGoalStateV1, ThreadGoalStatus } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

interface GoalResponse {
  goal: ThreadGoalStateV1 | null;
  nativeTargets?: Array<{ catId: string }>;
}

const STATUS_OPTIONS: Array<{ value: ThreadGoalStatus; label: string }> = [
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'blocked', label: '受阻' },
  { value: 'complete', label: '已完成' },
];

export function ThreadGoalSettingsContent({ threadId }: { threadId: string }) {
  const [goal, setGoal] = useState<ThreadGoalStateV1 | null>(null);
  const [objective, setObjective] = useState('');
  const [status, setStatus] = useState<ThreadGoalStatus>('active');
  const [tokenBudget, setTokenBudget] = useState('');
  const [nativeTargets, setNativeTargets] = useState<Array<{ catId: string }>>([]);
  const [selectedCatId, setSelectedCatId] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyResponse = useCallback((body: GoalResponse) => {
    setGoal(body.goal);
    if (body.nativeTargets) {
      setNativeTargets(body.nativeTargets);
      setSelectedCatId((current) =>
        body.nativeTargets?.some((target) => target.catId === current)
          ? current
          : (body.nativeTargets?.[0]?.catId ?? ''),
      );
    }
    if (body.goal?.intent === 'set') {
      setObjective(body.goal.objective ?? '');
      setStatus(body.goal.status ?? 'active');
      setTokenBudget(body.goal.tokenBudget == null ? '' : String(body.goal.tokenBudget));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/threads/${threadId}/goal`);
      if (!response.ok) throw new Error('load_failed');
      applyResponse((await response.json()) as GoalResponse);
    } catch {
      setError('目标读取失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, [applyResponse, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (path: string, init: RequestInit) => {
      setWorking(true);
      setError(null);
      try {
        const headers = new Headers(init.headers);
        headers.set('Content-Type', 'application/json');
        const response = await apiFetch(path, { ...init, headers });
        if (!response.ok && response.status !== 202) throw new Error('mutation_failed');
        applyResponse((await response.json()) as GoalResponse);
      } catch {
        setError('操作没有完成；已保存的对话目标不会因此丢失。');
      } finally {
        setWorking(false);
      }
    },
    [applyResponse],
  );

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = objective.trim();
    if (!trimmed) {
      setError('请先写下想达成的结果。');
      return;
    }
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null;
    if (parsedBudget != null && (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0)) {
      setError('Token 预算需要是正整数。');
      return;
    }
    void mutate(`/api/threads/${threadId}/goal`, {
      method: 'PUT',
      body: JSON.stringify({
        objective: trimmed,
        status,
        tokenBudget: parsedBudget,
        ...(selectedCatId ? { catId: selectedCatId } : {}),
      }),
    });
  };

  const reconcile = (mode: 'retry' | 'refresh') =>
    mutate(`/api/threads/${threadId}/goal/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ mode, ...(selectedCatId ? { catId: selectedCatId } : {}) }),
    });

  if (loading) return <p className="px-3 py-6 text-center text-xs text-cafe-muted">正在恢复对话目标…</p>;

  return (
    <form className="space-y-3 px-3 py-3" onSubmit={save}>
      <div>
        <label htmlFor={`thread-goal-${threadId}`} className="text-xs font-semibold text-cafe-black">
          想让这个对话达成什么？
        </label>
        <textarea
          id={`thread-goal-${threadId}`}
          name="objective"
          value={objective}
          maxLength={4000}
          rows={3}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="例如：完成可审查、可恢复的 Phase C 纵切片"
          className="mt-1.5 w-full resize-y rounded-lg border border-cafe-subtle bg-cafe-bg px-2.5 py-2 text-xs text-cafe-black outline-none focus:border-cafe-accent"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-micro text-cafe-muted">
          状态
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ThreadGoalStatus)}
            className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1.5 text-xs text-cafe-black"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-micro text-cafe-muted">
          Token 预算（可选）
          <input
            inputMode="numeric"
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.target.value)}
            placeholder="不限制"
            className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1.5 text-xs text-cafe-black"
          />
        </label>
      </div>
      {nativeTargets.length > 1 && (
        <label className="block text-micro text-cafe-muted">
          Codex 会话
          <select
            name="goalCatId"
            value={selectedCatId}
            onChange={(event) => setSelectedCatId(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1.5 text-xs text-cafe-black"
          >
            {nativeTargets.map((target) => (
              <option key={target.catId} value={target.catId}>
                {target.catId}
              </option>
            ))}
          </select>
        </label>
      )}
      <GoalSyncStatus goal={goal} />
      {error && <p className="text-micro text-conn-red-text">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={working}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs text-[var(--cafe-accent-foreground)]"
        >
          保存目标
        </button>
        {goal?.sync.state === 'unavailable' && (
          <button
            type="button"
            disabled={working}
            onClick={() => void reconcile('retry')}
            className="text-xs text-cafe-accent"
          >
            重试同步
          </button>
        )}
        <button
          type="button"
          disabled={working}
          onClick={() => void reconcile('refresh')}
          className="text-xs text-cafe-muted"
        >
          从 Codex 刷新
        </button>
        {goal && (
          <button
            type="button"
            disabled={working}
            onClick={() =>
              void mutate(`/api/threads/${threadId}/goal`, {
                method: 'DELETE',
                body: JSON.stringify(selectedCatId ? { catId: selectedCatId } : {}),
              })
            }
            className="ml-auto text-xs text-conn-red-text"
          >
            清除目标
          </button>
        )}
      </div>
    </form>
  );
}

function GoalSyncStatus({ goal }: { goal: ThreadGoalStateV1 | null }) {
  if (!goal) return <p className="text-micro text-cafe-muted">还没有设置目标。目标会保存在这个对话里。</p>;
  if (goal.intent === 'clear') {
    return <p className="text-micro text-cafe-muted">清除意图已经保存，等待 Codex 会话恢复后同步。</p>;
  }
  if (goal.sync.state === 'synced') {
    return <p className="text-micro text-cafe-muted">已同步到 Codex 原生目标；重新打开对话时会自动恢复。</p>;
  }
  return <p className="text-micro text-cafe-muted">已经保存在这个对话里；Codex 暂不可用时也不会丢失。</p>;
}
