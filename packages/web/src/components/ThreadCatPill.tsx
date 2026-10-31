'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { catColorVar } from '@/lib/cat-slug';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { executeSidebarFieldCommand } from '@/utils/sidebar-commands';
import { AppTooltip } from './AppTooltip';
import { ComposerPopover } from './ComposerPopover';
import { composerContextCopy } from './composer-context.shell-copy';
import { MemberSessionStrategy } from './MemberSessionStrategy';
import { ShellCatAvatar } from './shell/ShellCatAvatar';
import { ShellGlyph } from './shell/ShellIcons';
import { useShellCopy } from './shell/shell-copy';
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
  presentation?: 'header' | 'composer';
}

const NO_PREFERRED_CATS: string[] = [];

/** F154 Phase B — Shows preferred cat in thread header, click to open CatSelector popover. */
export function ThreadCatPill({ threadId, presentation = 'header' }: ThreadCatPillProps) {
  const isComposer = presentation === 'composer';
  const localized = useShellCopy(composerContextCopy);
  const copy = isComposer ? localized : composerContextCopy.zh;
  const { currentThread, setExactThread } = useThreadDisplayInfo(threadId, isComposer);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
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
  const preferredCats = isComposer
    ? (currentThread?.preferredCats ?? NO_PREFERRED_CATS)
    : (thread?.preferredCats ?? NO_PREFERRED_CATS);

  // Sync local selection when prop changes or popover closes; clear stale error on reopen
  useEffect(() => {
    if (isOpen) {
      setSaveError(false);
    } else {
      setSelectedCats([...preferredCats]);
    }
  }, [preferredCats, isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen || isComposer) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        pillRef.current &&
        !pillRef.current.contains(target)
      ) {
        setIsOpen(false);
        setSelectedCats([...preferredCats]);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, preferredCats, isComposer]);

  // P2-2: Close on resize/scroll (position becomes stale)
  useEffect(() => {
    if (!isOpen || isComposer) return;
    const close = () => {
      setIsOpen(false);
      setSelectedCats([...preferredCats]);
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
  }, [isOpen, preferredCats, isComposer]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      const ok = await executeSidebarFieldCommand({
        threadId,
        field: 'preferredCats',
        value: selectedCats,
        request: (signal) =>
          apiFetch(`/api/threads/${threadId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferredCats: selectedCats }),
            signal,
          }),
      });
      if (!ok) throw new Error('保存失败');
      updateThreadPreferredCats(threadId, selectedCats);
      setExactThread((previous) =>
        previous?.id === threadId && !('error' in previous) ? { ...previous, preferredCats: selectedCats } : previous,
      );
      if (threadRef.current === threadId) {
        setIsOpen(false);
        if (isComposer) pillRef.current?.focus();
      }
    } catch {
      if (threadRef.current === threadId) setSaveError(true);
    } finally {
      if (threadRef.current === threadId) setIsSaving(false);
    }
  }, [threadId, selectedCats, updateThreadPreferredCats, setExactThread, isComposer]);

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

  const selector = (
    <>
      <div className="p-3 overflow-y-auto max-h-[50vh]">
        <CatSelector
          selectedCats={selectedCats}
          onSelectionChange={handleSelectionChange}
          {...(isComposer ? { label: copy.optionalCats, familyLabel: copy.family, compact: true } : {})}
        />
      </div>
      {/* #921: Per-member session strategy control.
              Uses the persisted preferredCats (not draft selectedCats) so that
              strategy toggles don't fire PATCHes for unsaved selections — if
              the user cancels or save fails, no orphan strategy state remains.
              Component self-hides when API returns non-200 (shared default
              thread, system-indexed threads, or any access restriction). */}
      {preferredCats.length === 1 && (
        <MemberSessionStrategy threadId={threadId} catId={preferredCats[0]} presentation={presentation} />
      )}
      <div className="flex items-center justify-between px-3 pb-3 pt-2 border-t border-cafe-subtle flex-shrink-0">
        {saveError && <span className="text-micro text-conn-red-text">{copy.saveFailed}</span>}
        {!saveError && selectedCats.length > 0 && (
          <button
            type="button"
            onClick={() => setSelectedCats([])}
            className="text-micro text-cafe-muted hover:text-conn-red-text"
          >
            {copy.clear}
          </button>
        )}
        <div className="flex gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              if (isComposer) pillRef.current?.focus();
              setSelectedCats([...preferredCats]);
            }}
            className="text-xs px-2 py-0.5 rounded text-cafe-secondary hover:bg-cafe-surface-elevated"
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!hasChanged || isSaving}
            className="text-xs px-2 py-0.5 rounded bg-cafe-accent text-[var(--cafe-surface)] hover:bg-cafe-interactive disabled:opacity-40"
          >
            {isSaving ? '...' : copy.save}
          </button>
        </div>
      </div>
    </>
  );
  const catName = cat ? formatCatName(cat) : catId ? copy.unknownCat : copy.preferredCat;
  return (
    <>
      {isComposer ? (
        <AppTooltip label={`${copy.preferredCat}: ${catName}`} side="top" multiline disabled={isOpen}>
          <button
            ref={pillRef}
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            aria-label={`${copy.preferredCat}: ${catName}`}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            className="shell-focusable shell-rail-item inline-flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)]"
            data-testid="thread-cat-pill"
          >
            {catId && <ShellCatAvatar catId={catId} size={16} />}
            <span className="min-w-0 truncate">{catName}</span>
            <ShellGlyph name="chevronDown" className="h-3 w-3 flex-none" />
          </button>
        </AppTooltip>
      ) : (
        <button
          ref={pillRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border transition-colors text-xs ${
            cat
              ? 'border-cafe-subtle hover:bg-cafe-surface-sunken'
              : 'border-dashed border-cafe-muted hover:border-cafe-subtle hover:bg-cafe-surface-sunken'
          }`}
          data-testid="thread-cat-pill"
        >
          {cat ? (
            <>
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: catColorVar(cat.id, 'primary') }}
                data-testid="pill-dot"
              />
              <span className="text-cafe-secondary font-medium">{formatCatName(cat)}</span>
            </>
          ) : (
            <span className="text-cafe-muted">首选猫</span>
          )}
          <span className="text-cafe-muted">▾</span>
        </button>
      )}
      {isOpen &&
        (isComposer ? (
          <ComposerPopover anchor={pillRef} label={copy.selectCat} onClose={() => setIsOpen(false)}>
            {selector}
          </ComposerPopover>
        ) : (
          <div
            ref={popoverRef}
            style={getPopoverStyle()}
            className="bg-cafe-surface rounded-lg shadow-lg border border-cafe z-50 flex flex-col"
            onClick={(event) => event.stopPropagation()}
          >
            {selector}
          </div>
        ))}
    </>
  );
}
