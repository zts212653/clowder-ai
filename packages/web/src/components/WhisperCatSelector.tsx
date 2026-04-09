'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type CatData, formatCatName } from '@/hooks/useCatData';

interface WhisperCatSelectorProps {
  cats: CatData[];
  selected: Set<string>;
  activeCatIds: Set<string>;
  onToggle: (catId: string) => void;
}

/** F108 Scene 2 v2: Mention-like floating popup for whisper target selection.
 *  Mirrors the @ mention experience: compact, avatar+label+desc, positioned above input. */
export function WhisperCatSelector({ cats, selected, activeCatIds, onToggle }: WhisperCatSelectorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollDown, setCanScrollDown] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setCanScrollDown(el.scrollHeight > el.clientHeight + el.scrollTop + 4);
    check();
    el.addEventListener('scroll', check);
    return () => el.removeEventListener('scroll', check);
  }, []);

  return (
    <div className="absolute bottom-full left-4 mb-2 bg-cafe-surface rounded-xl shadow-lg border border-cafe overflow-hidden w-64 z-10 max-h-80 flex flex-col">
      <div className="px-4 py-1.5 text-xs text-amber-600 font-medium border-b border-cafe-subtle shrink-0">
        悄悄话目标 · 可多选
      </div>
      <div ref={scrollRef} className="overflow-y-auto flex-1">
        {cats.map((cat) => (
          <CatRow
            key={cat.id}
            cat={cat}
            isActive={activeCatIds.has(cat.id)}
            isSelected={selected.has(cat.id)}
            onToggle={onToggle}
          />
        ))}
      </div>
      {canScrollDown && (
        <div className="px-4 py-1 text-[10px] text-cafe-muted text-center border-t border-cafe-subtle bg-gradient-to-t from-white shrink-0">
          ↓ 还有更多猫猫
        </div>
      )}
      {selected.size === 0 && (
        <div className="px-4 py-1.5 text-xs text-red-400 border-t border-cafe-subtle shrink-0">请至少选一只猫猫</div>
      )}
    </div>
  );
}

/** Compact chip showing selected whisper targets below the input area. */
export function WhisperTargetChips({
  cats,
  selected,
  onToggle,
}: {
  cats: CatData[];
  selected: Set<string>;
  onToggle: (catId: string) => void;
}) {
  if (selected.size === 0) return null;
  const selectedCats = cats.filter((c) => selected.has(c.id));
  return (
    <div className="px-4 pt-1 flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-amber-600 shrink-0">悄悄话:</span>
      {selectedCats.map((cat) => (
        <button
          key={cat.id}
          type="button"
          onClick={() => onToggle(cat.id)}
          className="text-xs px-2 py-0.5 rounded-full border border-current bg-amber-50 font-medium transition-colors hover:opacity-70"
          style={{ color: cat.color.primary }}
        >
          {formatCatName(cat)} ×
        </button>
      ))}
    </div>
  );
}

function CatRow({
  cat,
  isActive,
  isSelected,
  onToggle,
}: {
  cat: CatData;
  isActive: boolean;
  isSelected: boolean;
  onToggle: (catId: string) => void;
}) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!isActive) onToggle(cat.id);
    },
    [isActive, cat.id, onToggle],
  );

  return (
    <button
      type="button"
      onMouseDown={handleClick}
      disabled={isActive}
      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
        isActive
          ? 'opacity-40 cursor-not-allowed'
          : isSelected
            ? 'bg-cafe-surface-elevated'
            : 'hover:bg-cafe-surface-elevated'
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={cat.avatar}
        alt={formatCatName(cat)}
        className="w-7 h-7 rounded-full shrink-0"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: cat.color.primary }}>
          {formatCatName(cat)}
          {isSelected && (
            <svg className="w-3.5 h-3.5 text-amber-500 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </div>
        <div className="text-xs text-cafe-muted truncate">{cat.roleDescription}</div>
      </div>
      {isActive && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-cafe-muted shrink-0">执行中</span>
      )}
    </button>
  );
}
