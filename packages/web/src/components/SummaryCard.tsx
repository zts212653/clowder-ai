'use client';

import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { CatAvatar } from './CatAvatar';

interface SummaryCardProps {
  topic: string;
  conclusions: string[];
  openQuestions: string[];
  createdBy: string;
  timestamp: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * SummaryCard — 拍立得照片墙风格纪要卡片
 * Polaroid-style card for discussion summaries.
 */
export function SummaryCard({ topic, conclusions, openQuestions, createdBy, timestamp }: SummaryCardProps) {
  // F032 P2: Use dynamic cat data instead of hardcoded CAT_NAMES
  const { getCatById } = useCatData();
  const coCreator = useCoCreatorConfig();
  const catData = getCatById(createdBy);
  // Special case: 'system' createdBy → '系统纪要', otherwise use cat displayName or configured co-creator name
  const creatorLabel = createdBy === 'system' ? '系统纪要' : (catData?.displayName ?? coCreator.name);

  return (
    <div className="flex justify-center mb-4">
      <div className="bg-cafe-surface border-2 border-cafe rounded-lg shadow-md px-5 pt-4 pb-5 max-w-md w-full rotate-[-0.5deg] hover:rotate-0 transition-transform">
        {/* Topic header */}
        <div className="text-sm font-bold text-cafe-secondary mb-3 flex items-center gap-1.5">
          <span>📷</span>
          <span>{topic}</span>
        </div>

        {/* Conclusions */}
        {conclusions.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-cafe-secondary mb-1">结论</div>
            <ul className="space-y-1">
              {conclusions.map((c, i) => (
                <li key={i} className="text-xs text-cafe-secondary flex gap-1.5">
                  <span className="text-green-500 flex-shrink-0">✓</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Open questions */}
        {openQuestions.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-cafe-secondary mb-1">待讨论</div>
            <ul className="space-y-1">
              {openQuestions.map((q, i) => (
                <li key={i} className="text-xs text-cafe-secondary flex gap-1.5">
                  <span className="text-amber-400 flex-shrink-0">?</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer: creator + time */}
        <div className="flex items-center gap-2 pt-2 border-t border-cafe-subtle">
          {createdBy === 'system' ? (
            <span className="text-xs">🤖</span>
          ) : catData ? (
            <CatAvatar catId={createdBy} size={16} />
          ) : (
            <span className="text-xs">👤</span>
          )}
          <span className="text-[10px] text-cafe-muted">
            {creatorLabel} · {formatTime(timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}
