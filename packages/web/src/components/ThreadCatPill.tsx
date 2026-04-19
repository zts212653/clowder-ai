'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CatSelector } from './ThreadSidebar/CatSelector';

/**
 * KD-5: v1 single-cat mode. When CatSelector calls back with multiple cats,
 * keep only the newly added one (replacing the old selection).
 * Exported for testability.
 */
export function enforceSingleSelect(newIds: string[], currentIds: string[]): string[] {
  if (newIds.length <= 1) return newIds;
  const added = newIds.find((id) => !currentIds.includes(id));
  return added ? [added] : [newIds[newIds.length - 1]];
}

/**
 * Compute popover position from pill rect, clamping to viewport edges.
 * Exported for testability (P2-2 right-edge clamp).
 */
export function computePopoverPosition(
  pillRect: { bottom: number; left: number },
  viewportWidth: number,
): { top: number; left: number; width: number } {
  const width = 280;
  const rightEdge = pillRect.left + width;
  const left = rightEdge > viewportWidth - 8 ? viewportWidth - width - 8 : Math.max(8, pillRect.left);
  return { top: pillRect.bottom + 6, left, width };
}

interface ThreadCatPillProps {
  threadId: string;
}

/** F154 Phase B — Shows preferred cat in thread header, click to open CatSelector popover. */
export function ThreadCatPill({ threadId }: ThreadCatPillProps) {
  const threads = useChatStore((s) => s.threads);
  const updateThreadPreferredCats = useChatStore((s) => s.updateThreadPreferredCats);
  const { getCatById } = useCatData();

  const [isOpen, setIsOpen] = useState(false);
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const thread = threads.find((t) => t.id === threadId);
  const preferredCats: string[] = thread?.preferredCats ?? [];

  // Sync local selection when prop changes or popover closes; clear stale error on reopen
  useEffect(() => {
    if (isOpen) {
      setSaveError(false);
    } else {
      setSelectedCats(preferredCats);
    }
  }, [preferredCats, isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        pillRef.current &&
        !pillRef.current.contains(target)
      ) {
        setIsOpen(false);
        setSelectedCats(preferredCats);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, preferredCats]);

  // P2-2: Close on resize/scroll (position becomes stale)
  useEffect(() => {
    if (!isOpen) return;
    const close = () => {
      setIsOpen(false);
      setSelectedCats(preferredCats);
    };
    const onScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [isOpen, preferredCats]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredCats: selectedCats }),
      });
      if (!res.ok) throw new Error('保存失败');
      updateThreadPreferredCats(threadId, selectedCats);
      setIsOpen(false);
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  }, [threadId, selectedCats, updateThreadPreferredCats]);

  // P1-1 KD-5: Enforce single-select when CatSelector calls back
  const handleSelectionChange = useCallback(
    (ids: string[]) => {
      setSelectedCats(enforceSingleSelect(ids, selectedCats));
    },
    [selectedCats],
  );

  /** Fixed position so popover escapes header overflow clipping (P2-2: right-edge clamp) */
  const getPopoverStyle = (): React.CSSProperties => {
    if (!pillRef.current) return {};
    const rect = pillRef.current.getBoundingClientRect();
    const pos = computePopoverPosition(rect, window.innerWidth);
    return { position: 'fixed', ...pos };
  };

  const catId = preferredCats[0];
  const cat = catId ? getCatById(catId) : undefined;

  const hasChanged = JSON.stringify([...selectedCats].sort()) !== JSON.stringify([...preferredCats].sort());

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border transition-colors text-xs ${
          cat
            ? 'border-cocreator-light hover:bg-cocreator-light'
            : 'border-dashed border-cafe-muted hover:border-cocreator-light hover:bg-cocreator-light'
        }`}
        data-testid="thread-cat-pill"
      >
        {cat ? (
          <>
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: cat.color.primary }}
              data-testid="pill-dot"
            />
            <span className="text-cafe-secondary font-medium">{formatCatName(cat)}</span>
          </>
        ) : (
          <span className="text-cafe-muted">首选猫</span>
        )}
        <span className="text-cafe-muted">▾</span>
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          style={getPopoverStyle()}
          className="bg-cafe-surface rounded-lg shadow-lg border border-cafe z-50 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-3 overflow-y-auto max-h-[50vh]">
            <CatSelector selectedCats={selectedCats} onSelectionChange={handleSelectionChange} />
          </div>
          <div className="flex items-center justify-between px-3 pb-3 pt-2 border-t border-cafe-subtle flex-shrink-0">
            {saveError && <span className="text-[10px] text-red-400">保存失败</span>}
            {!saveError && selectedCats.length > 0 && (
              <button onClick={() => setSelectedCats([])} className="text-[10px] text-cafe-muted hover:text-red-400">
                清除
              </button>
            )}
            <div className="flex gap-1.5 ml-auto">
              <button
                onClick={() => {
                  setIsOpen(false);
                  setSelectedCats(preferredCats);
                }}
                className="text-xs px-2 py-0.5 rounded text-cafe-secondary hover:bg-cafe-surface-elevated"
              >
                取消
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={!hasChanged || isSaving}
                className="text-xs px-2 py-0.5 rounded bg-cocreator-primary text-white hover:bg-cocreator-dark disabled:opacity-40"
              >
                {isSaving ? '...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
