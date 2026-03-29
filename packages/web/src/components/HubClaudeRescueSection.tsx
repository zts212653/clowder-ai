'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import type { ClaudeRescueRunResult, ClaudeRescueSessionItem } from './hub-claude-rescue.types';

function describeDetection(session: ClaudeRescueSessionItem): string {
  if (session.detectedBy === 'api_error_entry') return '已命中 Invalid signature API error';
  return '已命中救援规则';
}

async function parseJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

export function HubClaudeRescueSection() {
  const addToast = useToastStore((s) => s.addToast);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescuing, setRescuing] = useState(false);
  const [sessions, setSessions] = useState<ClaudeRescueSessionItem[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [lastRun, setLastRun] = useState<ClaudeRescueRunResult | null>(null);

  const scanSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/claude-rescue/sessions');
      const body = await parseJson<{ sessions?: ClaudeRescueSessionItem[]; error?: string }>(res);
      if (!res.ok) {
        setError(body.error ?? `扫描失败 (${res.status})`);
        return;
      }
      const nextSessions = [...(body.sessions ?? [])].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      setSessions(nextSessions);
      setSelectedSessionIds(nextSessions.map((session) => session.sessionId));
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scanSessions();
  }, [scanSessions]);

  const selectedTargets = useMemo(
    () => sessions.filter((session) => selectedSessionIds.includes(session.sessionId)),
    [selectedSessionIds, sessions],
  );

  const toggleSession = useCallback((sessionId: string) => {
    setSelectedSessionIds((prev) =>
      prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId].sort(),
    );
  }, []);

  const rescueSelected = useCallback(async () => {
    if (selectedTargets.length === 0 || rescuing) return;

    setRescuing(true);
    setError(null);
    try {
      const res = await apiFetch('/api/claude-rescue/rescue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionIds: selectedTargets.map((target) => target.sessionId),
        }),
      });
      const body = await parseJson<ClaudeRescueRunResult & { error?: string }>(res);
      if (!res.ok) {
        const message = body.error ?? `救援失败 (${res.status})`;
        setError(message);
        addToast({
          type: 'error',
          title: '布偶猫救援失败',
          message,
          duration: 5000,
        });
        return;
      }

      setLastRun(body);
      addToast({
        type: body.rescuedCount > 0 ? 'success' : 'info',
        title: body.rescuedCount > 0 ? '布偶猫已救活' : '布偶猫无需救活',
        message:
          body.rescuedCount > 0
            ? `救活 ${body.rescuedCount} 只布偶猫，跳过 ${body.skippedCount} 只。`
            : '没有需要动刀的坏 session。',
        duration: 3500,
      });
      await scanSessions();
    } catch {
      setError('网络错误');
      addToast({
        type: 'error',
        title: '布偶猫救援失败',
        message: '网络错误',
        duration: 5000,
      });
    } finally {
      setRescuing(false);
    }
  }, [addToast, rescuing, scanSessions, selectedTargets]);

  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold text-amber-900">布偶猫救援中心</h4>
          <button
            type="button"
            onClick={() => {
              void scanSessions();
            }}
            disabled={loading || rescuing}
            className="px-2.5 py-1 rounded border border-amber-300 bg-cafe-surface text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {loading ? '扫描中...' : '重新扫描'}
          </button>
        </div>
        <p className="text-xs text-amber-800">
          专治 Claude session 的坏 thinking signature。执行前会自动备份 transcript，只会移除纯 thinking-only assistant
          turn。
        </p>
        <p className="text-[11px] text-amber-700">扫描范围：当前机器上的 `~/.claude/projects/**/*.jsonl`</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      {lastRun && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 space-y-1">
          <p className="font-medium">刚刚救活 {lastRun.rescuedCount} 只布偶猫</p>
          <p>
            跳过 {lastRun.skippedCount} 只，处理 {lastRun.results.length} 个 session。
          </p>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-amber-700">扫描中...</p>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-amber-700">暂未发现坏掉的布偶猫 session</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-amber-900">检测到 {sessions.length} 只布偶猫 session 需要救援</p>
            <p className="text-[11px] text-amber-700">先勾选要动刀的 session，再执行一键救活。</p>
          </div>
          <div className="space-y-2">
            {sessions.map((session) => {
              const checked = selectedSessionIds.includes(session.sessionId);
              return (
                <label
                  key={session.sessionId}
                  className="flex items-start gap-2 rounded-lg border border-amber-200 bg-cafe-surface px-3 py-2 text-xs text-cafe-secondary"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSession(session.sessionId)}
                    className="mt-0.5"
                  />
                  <span className="space-y-0.5">
                    <span className="block font-medium text-cafe">{session.sessionId}</span>
                    <span className="block text-amber-800">纯 thinking turn：{session.removableThinkingTurns} 条</span>
                    <span className="block break-all text-cafe-secondary">{session.transcriptPath}</span>
                    <span className="block text-cafe-secondary">{describeDetection(session)}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              void rescueSelected();
            }}
            disabled={rescuing || selectedTargets.length === 0}
            className="px-3 py-1.5 rounded bg-amber-600 text-white text-xs hover:bg-amber-700 disabled:opacity-50"
          >
            {rescuing ? '救援中...' : `一键救活 ${selectedTargets.length} 只布偶猫`}
          </button>
        </div>
      )}
    </section>
  );
}
