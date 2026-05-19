'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { parseRebuildJob, type RebuildJobData } from './IndexStatus';

interface RawRebuildJob {
  id: string;
  status: string;
  phase: string;
  percent: number;
  error?: string;
  result?: { docsIndexed: number; docsSkipped: number; durationMs: number };
  startedAt: number;
  completedAt?: number;
}

const PHASE_LABELS: Record<string, string> = {
  scanning: '扫描文档',
  indexing: '建立索引',
  cleanup: '清理旧数据',
  embedding: '生成向量',
  done: '完成',
};

export function RebuildButton({ onComplete }: { onComplete: () => void }) {
  const [job, setJob] = useState<RebuildJobData | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/evidence/rebuild/${job.id}`);
        if (res.ok) {
          const raw = (await res.json()) as RawRebuildJob;
          const updated = parseRebuildJob(raw);
          setJob(updated);
          if (updated.status === 'done' || updated.status === 'error') {
            onComplete();
          }
        } else if (res.status === 404) {
          setJob((prev) => (prev ? { ...prev, status: 'error', error: '任务状态丢失（服务可能已重启）' } : null));
        }
      } catch {
        /* poll failure is transient */
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [job, onComplete]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await apiFetch('/api/evidence/rebuild', { method: 'POST' });
      if (res.ok) {
        const { taskId } = (await res.json()) as { taskId: string };
        setJob({ id: taskId, status: 'pending', phase: '', percent: 0, startedAt: Date.now() });
      } else {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const msg =
          res.status === 409 ? '已有重建任务进行中' : ((body as { error?: string }).error ?? `HTTP ${res.status}`);
        setJob({ id: '', status: 'error', phase: '', percent: 0, startedAt: Date.now(), error: msg });
      }
    } catch {
      setJob({ id: '', status: 'error', phase: '', percent: 0, startedAt: Date.now(), error: '网络错误' });
    } finally {
      setStarting(false);
    }
  }, []);

  if (job && (job.status === 'pending' || job.status === 'running')) {
    return (
      <div data-testid="rebuild-progress" className="flex-1 rounded-lg bg-[var(--console-card-bg)] px-3 py-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-cafe-secondary">{PHASE_LABELS[job.phase] ?? (job.phase || '准备中')}</span>
          <span className="font-medium text-cafe-black">{job.percent}%</span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-cafe-surface">
          <div className="h-full rounded-full bg-[#6BAF8D] transition-all" style={{ width: `${job.percent}%` }} />
        </div>
      </div>
    );
  }

  if (job?.status === 'done' && job.result) {
    return (
      <div data-testid="rebuild-done" className="flex items-center gap-2">
        <span className="rounded bg-conn-green-bg px-2 py-1 text-[10px] text-conn-green-text">
          索引 {job.result.docsIndexed} 篇 · {(job.result.durationMs / 1000).toFixed(1)}s
        </span>
        <button
          type="button"
          disabled={starting}
          onClick={handleStart}
          className={`rounded-lg border border-cafe bg-white px-3 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface ${starting ? 'opacity-50' : ''}`}
        >
          重建索引
        </button>
      </div>
    );
  }

  if (job?.status === 'error') {
    return (
      <div data-testid="rebuild-error" className="flex items-center gap-2">
        <span className="rounded bg-conn-red-bg px-2 py-1 text-[10px] text-red-700">{job.error}</span>
        <button
          type="button"
          disabled={starting}
          onClick={handleStart}
          className={`rounded-lg border border-cafe bg-white px-3 py-1.5 text-xs text-conn-red-text transition-colors hover:bg-conn-red-bg ${starting ? 'opacity-50' : ''}`}
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={starting}
      onClick={handleStart}
      data-testid="rebuild-button"
      className={`rounded-lg border border-cafe bg-white px-3 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface ${starting ? 'opacity-50' : ''}`}
    >
      重建索引
    </button>
  );
}
