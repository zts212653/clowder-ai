'use client';

import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { CatAvatar } from './CatAvatar';
import { HubIcon } from './hub-icons';

interface SummaryCardProps {
  topic: string;
  conclusions: string[];
  openQuestions: string[];
  createdBy: string;
  timestamp: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
          <HubIcon name="camera" className="h-3.5 w-3.5" />
          <span>{topic}</span>
        </div>

        {/* Conclusions */}
        {conclusions.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-cafe-secondary mb-1">结论</div>
            <ul className="space-y-1">
              {conclusions.map((c, i) => (
                <li key={i} className="text-xs text-cafe-secondary flex gap-1.5">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3 w-3 text-green-500 flex-shrink-0"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
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
            <HubIcon name="bot" className="h-3.5 w-3.5 text-cafe-secondary" />
          ) : catData ? (
            <CatAvatar catId={createdBy} size={16} />
          ) : (
            <HubIcon name="user" className="h-3.5 w-3.5 text-cafe-secondary" />
          )}
          <span className="text-[10px] text-cafe-muted">
            {creatorLabel} · {formatTime(timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}
