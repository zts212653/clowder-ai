'use client';

import type { DispatchExecutionDigest } from '@cat-cafe/shared';

interface DispatchProgressProps {
  digests: DispatchExecutionDigest[];
}

const STATUS_STYLES: Record<DispatchExecutionDigest['status'], { bg: string; text: string; label: string }> = {
  completed: { bg: 'bg-green-100', text: 'text-green-800', label: '完成' },
  partial: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: '部分完成' },
  blocked: { bg: 'bg-red-100', text: 'text-red-800', label: '受阻' },
};

export function DispatchProgress({ digests }: DispatchProgressProps) {
  if (digests.length === 0) {
    return (
      <div className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-8 text-center text-sm text-[#9A866F]">
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
          <div key={digest.id} className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-4">
            {/* Header: status + cat + time */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
                  {style.label}
                </span>
                <span className="text-[11px] font-medium text-[#6B5D4F]">@{digest.catId}</span>
              </div>
              <span className="text-[10px] text-[#9A866F]">
                {new Date(digest.completedAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>

            {/* Mission summary */}
            <p className="mt-2 text-sm text-[#4B3A2A]">{digest.summary}</p>

            {/* Mission context */}
            <div className="mt-2 text-[11px] text-[#9A866F]">
              <span className="font-medium">任务:</span> {digest.missionPack.mission}
            </div>

            {/* doneWhen checklist */}
            {totalCriteria > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] font-medium text-[#8B6F47]">
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
                      className={`h-3 w-3 shrink-0 ${r.met ? 'text-green-600' : 'text-red-500'}`}
                    >
                      <path d={r.met ? 'M20 6L9 17l-5-5' : 'M18 6L6 18M6 6l12 12'} />
                    </svg>
                    <span className="text-[#6B5D4F]">
                      {r.criterion}
                      {r.evidence && <span className="ml-1 text-[#9A866F]">— {r.evidence}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Files changed */}
            {digest.filesChanged.length > 0 && (
              <div className="mt-2">
                <span className="text-[10px] font-medium text-[#8B6F47]">变更文件 ({digest.filesChanged.length})</span>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {digest.filesChanged.map((f) => (
                    <span key={f} className="rounded bg-[#F4EFE7] px-1.5 py-0.5 text-[10px] font-mono text-[#6B5D4F]">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Next steps */}
            {digest.nextSteps.length > 0 && (
              <div className="mt-2 text-[11px] text-[#9A866F]">
                <span className="font-medium">下一步:</span> {digest.nextSteps.join('; ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
