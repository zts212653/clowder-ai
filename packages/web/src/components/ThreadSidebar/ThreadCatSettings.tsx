'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CatSelector } from './CatSelector';

interface ThreadCatSettingsProps {
  threadId: string;
  currentCats: string[];
  onSave: (threadId: string, cats: string[]) => void | Promise<void>;
}

/**
 * F32-b Phase 3: Inline popover to edit a thread's preferredCats.
 * Shown as a small icon button; opens CatSelector in a positioned dropdown.
 */
export function ThreadCatSettings({ threadId, currentCats, onSave }: ThreadCatSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCats, setSelectedCats] = useState<string[]>(currentCats);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync when prop changes (e.g. server-side update)
  useEffect(() => {
    if (!isOpen) setSelectedCats(currentCats);
  }, [currentCats, isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSelectedCats(currentCats); // revert on cancel
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, currentCats]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      await onSave(threadId, selectedCats);
      setIsOpen(false);
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  }, [threadId, selectedCats, onSave]);

  const hasChanged = JSON.stringify([...selectedCats].sort()) !== JSON.stringify([...currentCats].sort());

  /** Fixed position so popover escapes sidebar overflow-y-auto clipping */
  const getPopoverStyle = (): React.CSSProperties => {
    if (!buttonRef.current) return {};
    const rect = buttonRef.current.getBoundingClientRect();
    const width = 256; // 16rem
    return {
      position: 'fixed',
      top: rect.bottom + 4,
      left: Math.max(8, rect.right - width),
      width,
    };
  };

  return (
    <div ref={popoverRef}>
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={`p-0.5 rounded transition-all ${
          currentCats.length > 0
            ? 'text-cocreator-primary'
            : 'opacity-0 group-hover:opacity-100 text-cafe-muted hover:text-cocreator-primary'
        }`}
        title="设置默认猫猫"
      >
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1C4.7 1 2 3.2 2 6c0 1.4.7 2.6 1.7 3.5-.1.8-.4 1.6-.9 2.3a.5.5 0 00.4.8c1.2 0 2.3-.5 3.1-1.1.5.1 1.1.2 1.7.2 3.3 0 6-2.2 6-5S11.3 1 8 1z" />
        </svg>
      </button>
      {isOpen && (
        <div
          style={getPopoverStyle()}
          className="bg-cafe-surface rounded-lg shadow-lg border border-cafe z-50 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-3 overflow-y-auto max-h-[50vh]">
            <CatSelector selectedCats={selectedCats} onSelectionChange={setSelectedCats} />
          </div>
          {saveError && <p className="text-[10px] text-red-500 px-3 mt-1">保存失败，请重试</p>}
          <div className="flex items-center justify-between px-3 pb-3 pt-2 border-t border-cafe-subtle flex-shrink-0">
            {selectedCats.length > 0 && (
              <button onClick={() => setSelectedCats([])} className="text-[10px] text-cafe-muted hover:text-red-400">
                清除
              </button>
            )}
            <div className="flex gap-1.5 ml-auto">
              <button
                onClick={() => {
                  setIsOpen(false);
                  setSelectedCats(currentCats);
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
    </div>
  );
}
