'use client';
import type { CacheRetentionMemberStatus } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HelpTip } from '../HelpTip';

const reasons: Record<string, string> = {
  repeated_cold_return: '连续两次回来时缓存读取低于 95%，已停止这个会话的续约。',
  preference_changed: '缓存保留设置已更改。',
  window_missed: '已错过续约时间，本轮不补发。',
  dispatch_finished_or_unverifiable: '交回已完成，或无法确认仍在等待。',
  interrupted_attempt_cost_unknown: '上次维护被中断，费用未确认，本轮不重试。',
  maintenance_failed_cost_unconfirmed: '上次维护未完成，费用未确认，本轮不重试。',
  real_return: '伙伴已经回来。',
  source_changed: '会话、模型或上下文已变化，本轮维护已停止。',
  two_hour_limit: '已到两小时上限，本轮不再维护。',
};
export function MemberCacheRetention({ catId }: { catId: string }) {
  const [status, setStatus] = useState<CacheRetentionMemberStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    setStatus(null);
    setError(null);
    const load = async () => {
      const started = generation.current;
      try {
        const response = await apiFetch(`/api/cats/${encodeURIComponent(catId)}/cache-retention`);
        if (!response.ok) throw new Error('读取缓存保留设置失败');
        const value: CacheRetentionMemberStatus = await response.json();
        if (!disposed && started === generation.current && !pending.current) {
          setStatus(value);
          setError(null);
        }
      } catch {
        if (!disposed && started === generation.current && !pending.current) setError('读取缓存保留设置失败');
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [catId, retry]);
  if (status && !status.supported) return null;
  const save = async () => {
    if (!status || busy) return;
    generation.current++;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/cats/${encodeURIComponent(catId)}/cache-retention`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      if (!response.ok) throw new Error('保存失败');
      setStatus(await response.json());
    } catch {
      setError('保存结果未确认，请重新读取设置。');
    } finally {
      setBusy(false);
      generation.current++;
      pending.current = false;
    }
  };
  return (
    <section className="mt-6 border-t border-[var(--console-border-soft)] pt-5" aria-label="缓存保留设置">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-cafe-primary">
            延长缓存保留
            <HelpTip topic="延长缓存保留">
              只在派活后等待伙伴交回、且缓存仍热时延长；只在最初两小时内维护。维护会消耗 Claude
              额度；关闭后停止后续维护，不改变会话内容。
            </HelpTip>
          </div>
          <p className="mt-1 text-xs text-cafe-secondary">更改立即生效。等待交回时维护缓存，最多两小时。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="延长缓存保留"
          aria-checked={status?.enabled ?? false}
          disabled={!status || busy}
          onClick={() => void save()}
          className="flex min-h-11 w-11 shrink-0 items-center justify-center disabled:opacity-50"
        >
          <span
            className={`relative h-4 w-[26px] rounded-full border transition-colors ${status?.enabled ? 'border-[var(--cafe-text)] bg-[var(--cafe-text)]' : 'border-[var(--cafe-text-muted)] bg-[var(--console-card-bg)]'}`}
          >
            <span
              className={`absolute left-px top-px h-3 w-3 rounded-full transition-transform ${status?.enabled ? 'translate-x-[10px] bg-[var(--console-card-bg)]' : 'bg-[var(--cafe-text-muted)]'}`}
            />
          </span>
        </button>
      </div>
      {!status && !error && <p className="mt-2 text-xs text-cafe-secondary">正在读取设置…</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-cafe-secondary">
          {error}{' '}
          <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline">
            重试
          </button>
        </p>
      )}
      {status?.sessions.map((session) => (
        <div key={`${session.threadId}:${session.sessionId}`} className="mt-3 text-xs text-cafe-secondary">
          <p>
            {session.state === 'stopped'
              ? (reasons[session.reason ?? ''] ?? '本轮缓存维护已停止。')
              : session.retainUntil
                ? `缓存保留至 ${new Date(session.retainUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : '正在等待交回。'}
          </p>
          {session.lastReturnReadRatio !== undefined && (
            <p>下次回来时读取命中 {(session.lastReturnReadRatio * 100).toFixed(1)}%</p>
          )}
        </div>
      ))}
    </section>
  );
}
