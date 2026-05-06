'use client';

import type { DispatchExecutionDigest } from '@cat-cafe/shared';

interface DispatchProgressProps {
  digests: DispatchExecutionDigest[];
}

const STATUS_STYLES: Record<DispatchExecutionDigest['status'], { bg: string; text: string; label: string }> = {
  completed: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: '完成' },
  partial: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '部分完成' },
  blocked: { bg: 'bg-conn-red-bg', text: 'text-conn-red-text', label: '受阻' },
};

export function DispatchProgress({ digests }: DispatchProgressProps) {
  if (digests.length === 0) {
    return (
      <div className="rounded-lg bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] p-8 text-center text-sm text-cafe-muted">
        暂无派遣记录
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {digests.map((digest) => {
        const style = STATUS_STYLES[digest.status];
        const metCount = digest.doneWhenResults.filter((r) => r.met).length;
        const totalCriteria = digest.doneWhenResults.length;

        return (
          <div
            key={digest.id}
            className="rounded-lg bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] p-4"
          >
            {/* Header: status + cat + time */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
                  {style.label}
                </span>
                <span className="text-[11px] font-medium text-cafe-secondary">@{digest.catId}</span>
              </div>
              <span className="text-[10px] text-cafe-muted">
                {new Date(digest.completedAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>

            {/* Mission summary */}
            <p className="mt-2 text-sm text-cafe">{digest.summary}</p>

            {/* Mission context */}
            <div className="mt-2 text-[11px] text-cafe-muted">
              <span className="font-medium">任务:</span> {digest.missionPack.mission}
            </div>

            {/* doneWhen checklist */}
            {totalCriteria > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] font-medium text-[var(--cafe-accent)]">
                  完成标准 ({metCount}/{totalCriteria})
                </div>
                {digest.doneWhenResults.map((r) => (
                  <div key={r.criterion} className="flex items-start gap-1.5 text-[11px]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`h-3 w-3 shrink-0 ${r.met ? 'text-conn-emerald-text' : 'text-conn-red-text'}`}
                    >
                      <path d={r.met ? 'M20 6L9 17l-5-5' : 'M18 6L6 18M6 6l12 12'} />
                    </svg>
                    <span className="text-cafe-secondary">
                      {r.criterion}
                      {r.evidence && <span className="ml-1 text-cafe-muted">— {r.evidence}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Files changed */}
            {digest.filesChanged.length > 0 && (
              <div className="mt-2">
                <span className="text-[10px] font-medium text-[var(--cafe-accent)]">
                  变更文件 ({digest.filesChanged.length})
                </span>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {digest.filesChanged.map((f) => (
                    <span
                      key={f}
                      className="rounded bg-[var(--console-pill-bg)] px-1.5 py-0.5 text-[10px] font-mono text-cafe-secondary"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Next steps */}
            {digest.nextSteps.length > 0 && (
              <div className="mt-2 text-[11px] text-cafe-muted">
                <span className="font-medium">下一步:</span> {digest.nextSteps.join('; ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
