'use client';

import { useCallback, useEffect, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { DEFAULT_LABEL_COLOR } from '@/lib/color-defaults';
import { type ThreadLabel, useLabelStore } from '@/stores/label-store';

interface ThreadLabelSettingsContentProps {
  threadId: string;
  currentLabels: string[];
  onSave: (threadId: string, labels: string[]) => void | Promise<void>;
}

/** Embedded label editor for the unified thread settings surface. */
export function ThreadLabelSettingsContent({ threadId, currentLabels, onSave }: ThreadLabelSettingsContentProps) {
  const { labels, fetchLabels, createLabel, deleteLabel } = useLabelStore();
  const [savedLabels, setSavedLabels] = useState(currentLabels);
  const [selected, setSelected] = useState<string[]>(currentLabels);
  const [isSaving, setIsSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_LABEL_COLOR);
  const [saveError, setSaveError] = useState(false);
  const ime = useIMEGuard();

  useEffect(() => {
    setSavedLabels(currentLabels);
    setSelected(currentLabels);
  }, [currentLabels]);

  useEffect(() => {
    if (labels.length === 0) void fetchLabels();
  }, [labels.length, fetchLabels]);

  const toggleLabel = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((labelId) => labelId !== id) : [...prev, id]));
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      await onSave(threadId, selected);
      setSavedLabels(selected);
    } catch {
      setSaveError(true);
      setSelected(savedLabels);
    } finally {
      setIsSaving(false);
    }
  }, [threadId, selected, onSave, savedLabels]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteLabel(id);
      if (!useLabelStore.getState().labels.some((label) => label.id === id)) {
        setSelected((prev) => prev.filter((labelId) => labelId !== id));
      }
    },
    [deleteLabel],
  );

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    const label = await createLabel(newName.trim(), newColor);
    if (label) {
      setSelected((prev) => [...prev, label.id]);
      setShowCreate(false);
      setNewName('');
    }
  }, [newName, newColor, createLabel]);

  const hasChanged = JSON.stringify([...selected].sort()) !== JSON.stringify([...savedLabels].sort());

  return (
    <div className="flex flex-col">
      <div className="max-h-[46vh] overflow-y-auto p-3">
        {labels.length === 0 && !showCreate ? (
          <p className="py-2 text-center text-xs text-cafe-muted">还没有标签</p>
        ) : (
          <div className="flex flex-col gap-1">
            {labels.map((label) => (
              <LabelCheckbox
                key={label.id}
                label={label}
                checked={selected.includes(label.id)}
                onChange={() => toggleLabel(label.id)}
                onDelete={() => void handleDelete(label.id)}
              />
            ))}
          </div>
        )}
        {showCreate ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={newColor}
                onChange={(event) => setNewColor(event.target.value)}
                className="h-6 w-6 cursor-pointer rounded border-0 p-0"
              />
              <input
                type="text"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                placeholder="标签名称"
                maxLength={20}
                className="flex-1 rounded border border-cafe-subtle bg-cafe-surface px-1.5 py-1 text-xs focus:border-cafe-accent focus:outline-none"
                onKeyDown={(event) => {
                  if (ime.isComposing()) return;
                  if (event.key === 'Enter') void handleCreate();
                  if (event.key === 'Escape') setShowCreate(false);
                }}
              />
            </div>
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-1.5 py-0.5 text-micro text-cafe-muted hover:text-cafe-secondary"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={!newName.trim()}
                className="rounded bg-cafe-accent px-1.5 py-0.5 text-micro text-[var(--cafe-surface)] disabled:opacity-40"
              >
                创建
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="mt-2 w-full text-left text-micro text-cafe-accent hover:underline"
          >
            + 新建标签
          </button>
        )}
      </div>
      {saveError && <p className="px-3 text-micro text-conn-red-text">保存失败，请重试</p>}
      <div className="flex flex-shrink-0 items-center justify-between border-t border-cafe-subtle px-3 py-2.5">
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected([])}
            className="text-micro text-cafe-muted hover:text-conn-red-text"
          >
            清除
          </button>
        )}
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelected(savedLabels);
              setShowCreate(false);
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

function LabelCheckbox({
  label,
  checked,
  onChange,
  onDelete,
}: {
  label: ThreadLabel;
  checked: boolean;
  onChange: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group/label flex items-center gap-2 rounded px-1 py-0.5 hover:bg-cafe-surface-elevated">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <input type="checkbox" checked={checked} onChange={onChange} className="rounded accent-cafe-accent" />
        <span
          className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: label.color }}
        />
        <span className="truncate text-xs text-cafe-secondary">{label.name}</span>
      </label>
      <button
        type="button"
        data-testid={`delete-label-${label.id}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="flex-shrink-0 p-0.5 text-cafe-muted opacity-0 transition-opacity hover:text-conn-red-text focus:opacity-100 group-hover/label:opacity-100"
        aria-label="删除标签"
      >
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
        </svg>
      </button>
    </div>
  );
}
