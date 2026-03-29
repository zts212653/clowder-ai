'use client';

import type { IntentCard, TriageBucket } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { BucketBadge, SourceBadge } from './TriageBadge';

interface TranslationMatrixProps {
  cards: IntentCard[];
  selectedCardId: string | null;
  onSelectCard: (id: string) => void;
  onCreateCard: () => void;
}

const BUCKET_FILTERS: { value: TriageBucket | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'build_now', label: 'Build Now' },
  { value: 'clarify_first', label: 'Clarify' },
  { value: 'validate_first', label: 'Validate' },
  { value: 'challenge', label: 'Challenge' },
  { value: 'later', label: 'Later' },
];

export function TranslationMatrix({ cards, selectedCardId, onSelectCard, onCreateCard }: TranslationMatrixProps) {
  const [bucketFilter, setBucketFilter] = useState<TriageBucket | 'all'>('all');

  const filtered = useMemo(
    () => (bucketFilter === 'all' ? cards : cards.filter((c) => c.triage?.bucket === bucketFilter)),
    [cards, bucketFilter],
  );

  const triaged = cards.filter((c) => c.triage).length;
  const buildNow = cards.filter((c) => c.triage?.bucket === 'build_now').length;
  const unresolved = cards.filter(
    (c) => c.triage?.bucket === 'clarify_first' || c.triage?.bucket === 'validate_first',
  ).length;

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs text-[#6B5D4F]">
          <span>
            {triaged}/{cards.length} triaged
          </span>
          <span>{buildNow} Build Now</span>
          <span>{unresolved} unresolved</span>
        </div>
        <button
          type="button"
          onClick={onCreateCard}
          className="rounded-lg bg-[#8B6F47] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#7A6139]"
        >
          + 新建 Intent Card
        </button>
      </div>

      {/* Filter */}
      <div className="flex gap-1">
        {BUCKET_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setBucketFilter(f.value)}
            className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
              bucketFilter === f.value ? 'bg-[#8B6F47] text-white' : 'bg-[#F4EFE7] text-[#6B5D4F] hover:bg-[#E7DAC7]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-8 text-center text-sm text-[#9A866F]">
          {cards.length === 0 ? '尚无 Intent Cards。点击上方按钮开始需求翻译。' : '当前筛选无结果。'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[#E7DAC7]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F9F5EE] text-[10px] font-semibold uppercase text-[#9A866F]">
              <tr>
                <th className="px-3 py-2">甲方原文</th>
                <th className="px-3 py-2">Intent Card</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Triage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0E8DB]">
              {filtered.map((card) => (
                <tr
                  key={card.id}
                  onClick={() => onSelectCard(card.id)}
                  className={`cursor-pointer transition-colors hover:bg-[#FBF7F0] ${
                    selectedCardId === card.id ? 'bg-[#F7EEDB]' : 'bg-cafe-surface'
                  }`}
                >
                  <td className="max-w-[200px] truncate px-3 py-2 text-[#2B2118]">{card.originalText || '—'}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-[#6B5D4F]">
                    {card.actor} → {card.goal}
                  </td>
                  <td className="px-3 py-2">
                    <SourceBadge tag={card.sourceTag} />
                  </td>
                  <td className="px-3 py-2">
                    {card.triage ? (
                      <BucketBadge bucket={card.triage.bucket} />
                    ) : (
                      <span className="text-[10px] text-[#B8A88F]">未评估</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
