'use client';

import { useCallback, useEffect, useState } from 'react';
import { CatSelector } from './CatSelector';

interface ThreadCatSettingsContentProps {
  threadId: string;
  currentCats: string[];
  onSave: (threadId: string, cats: string[]) => void | Promise<void>;
}

/** Embedded preferred-cat editor for the unified thread settings surface. */
export function ThreadCatSettingsContent({ threadId, currentCats, onSave }: ThreadCatSettingsContentProps) {
  const [savedCats, setSavedCats] = useState(currentCats);
  const [selectedCats, setSelectedCats] = useState(currentCats);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    setSavedCats(currentCats);
    setSelectedCats(currentCats);
  }, [currentCats]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      await onSave(threadId, selectedCats);
      setSavedCats(selectedCats);
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  }, [threadId, selectedCats, onSave]);

  const hasChanged = JSON.stringify([...selectedCats].sort()) !== JSON.stringify([...savedCats].sort());

  return (
    <div className="flex flex-col">
      <div className="max-h-[46vh] overflow-y-auto px-3 py-3">
        <CatSelector selectedCats={selectedCats} onSelectionChange={setSelectedCats} />
      </div>
      {saveError && <p className="px-3 text-micro text-conn-red-text">保存失败，请重试</p>}
      <div className="flex flex-shrink-0 items-center justify-between border-t border-cafe-subtle px-3 py-2.5">
        {selectedCats.length > 0 && (
          <button
            type="button"
            onClick={() => setSelectedCats([])}
            className="text-micro text-cafe-muted hover:text-conn-red-text"
          >
            清除
          </button>
        )}
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedCats(savedCats);
              setSaveError(false);
            }}
            className="rounded px-2 py-0.5 text-xs text-cafe-secondary hover:bg-cafe-surface-elevated"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!hasChanged || isSaving}
            className="rounded bg-cafe-accent px-2 py-0.5 text-xs text-[var(--cafe-surface)] hover:bg-cafe-interactive disabled:opacity-40"
          >
            {isSaving ? '...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
