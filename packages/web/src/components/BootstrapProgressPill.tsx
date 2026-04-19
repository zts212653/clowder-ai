import { useState } from 'react';
import type { BootstrapProgress } from '@/hooks/useIndexState';

interface BootstrapProgressPillProps {
  progress: BootstrapProgress;
  expanded?: boolean;
}

const PHASE_LABELS = ['扫描文件', '提取结构', '构建索引', '生成摘要'] as const;

export function BootstrapProgressPill({ progress, expanded: defaultExpanded }: BootstrapProgressPillProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  return (
    <div data-testid="bootstrap-progress-pill" className="flex justify-center mb-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-cocreator-primary/20 bg-cocreator-bg/50 hover:bg-cocreator-bg transition-colors text-xs"
      >
        <span className="inline-block w-3 h-3 rounded-full bg-cocreator-primary animate-pulse" />
        <span className="text-cocreator-dark font-medium">建立记忆索引…</span>
        <span className="text-gray-400">
          {PHASE_LABELS[progress.phaseIndex] ?? ''} ({progress.phaseIndex + 1}/{progress.totalPhases})
        </span>
        <span className={`text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {expanded && (
        <div className="absolute mt-9 z-10 w-64 rounded-lg border border-cocreator-primary/20 bg-white shadow-lg p-3">
          <div className="space-y-2">
            {PHASE_LABELS.map((label, i) => {
              const isDone = i < progress.phaseIndex;
              const isActive = i === progress.phaseIndex;
              return (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
                      isDone
                        ? 'bg-cocreator-primary text-white'
                        : isActive
                          ? 'bg-cocreator-primary/20 text-cocreator-primary'
                          : 'bg-gray-100 text-gray-400'
                    }`}
                  >
                    {isDone ? '\u2713' : i + 1}
                  </span>
                  <span
                    className={
                      isDone ? 'text-cocreator-dark' : isActive ? 'text-cafe-black font-medium' : 'text-gray-400'
                    }
                  >
                    {label}
                  </span>
                  {isActive && <span className="text-gray-400 animate-pulse">…</span>}
                </div>
              );
            })}
          </div>
          {progress.docsTotal > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-cocreator-primary transition-all duration-300"
                  style={{ width: `${Math.min(100, (progress.docsProcessed / progress.docsTotal) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-1">
                {progress.docsProcessed} / {progress.docsTotal} 文档
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
