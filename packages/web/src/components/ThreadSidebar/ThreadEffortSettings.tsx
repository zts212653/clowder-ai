'use client';

import type { CliEffortPreset, ThreadMemberEffortListResponse, ThreadMemberEffortRow } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { apiFetch } from '@/utils/api-client';

interface ThreadEffortSettingsProps {
  threadId: string;
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  triggerRole?: 'menuitem';
}

export function ThreadEffortSettings({
  threadId,
  triggerLabel,
  triggerIcon,
  triggerClassName,
  triggerRole,
}: ThreadEffortSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [rows, setRows] = useState<ThreadMemberEffortRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingCatId, setSavingCatId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const loadRows = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const response = await apiFetch(`/api/threads/${threadId}/members/effort`);
      if (!response.ok) throw new Error('load failed');
      const body = (await response.json()) as ThreadMemberEffortListResponse;
      setRows(body.members);
    } catch {
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (!isOpen) return;
    void loadRows();
  }, [isOpen, loadRows]);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? (rows ?? []).filter(
          (row) =>
            row.displayName.toLocaleLowerCase().includes(needle) ||
            String(row.catId).toLocaleLowerCase().includes(needle),
        )
      : (rows ?? []);
    return [...filtered].sort((left, right) => {
      if (left.isParticipant !== right.isParticipant) return left.isParticipant ? -1 : 1;
      return left.displayName.localeCompare(right.displayName);
    });
  }, [query, rows]);

  const saveEffort = useCallback(
    async (row: ThreadMemberEffortRow, next: CliEffortPreset | null) => {
      const previous = row;
      const isCompatible = next === null || row.options.includes(next);
      const optimistic: ThreadMemberEffortRow = {
        ...row,
        override: next,
        effective: next && isCompatible ? next : row.inherited,
        source: next && isCompatible ? 'thread_override' : 'inherited',
        compatibility: isCompatible ? 'compatible' : 'incompatible',
      };
      setSaveError(null);
      setSavingCatId(String(row.catId));
      setRows((current) => current?.map((item) => (item.catId === row.catId ? optimistic : item)) ?? current);
      try {
        const response = await apiFetch(`/api/threads/${threadId}/members/${row.catId}/effort`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ effort: next }),
        });
        if (!response.ok) throw new Error('save failed');
        const saved = (await response.json()) as ThreadMemberEffortRow;
        setRows((current) => current?.map((item) => (item.catId === row.catId ? saved : item)) ?? current);
      } catch {
        setRows((current) => current?.map((item) => (item.catId === row.catId ? previous : item)) ?? current);
        setSaveError(String(row.catId));
      } finally {
        setSavingCatId(null);
      }
    },
    [threadId],
  );

  const getPopoverStyle = (): React.CSSProperties => {
    if (!buttonRef.current) return {};
    const rect = buttonRef.current.getBoundingClientRect();
    const viewportPadding = 8;
    const minimumPanelHeight = 160;
    const width = Math.max(0, Math.min(360, window.innerWidth - viewportPadding * 2));
    const top = Math.max(
      viewportPadding,
      Math.min(rect.bottom + 4, window.innerHeight - minimumPanelHeight - viewportPadding),
    );
    return {
      position: 'fixed',
      top,
      left: Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding)),
      width,
      maxHeight: Math.max(0, window.innerHeight - top - viewportPadding),
    };
  };

  const participants = visibleRows.filter((row) => row.isParticipant);
  const others = visibleRows.filter((row) => !row.isParticipant);

  return (
    <div ref={popoverRef}>
      <button
        ref={buttonRef}
        type="button"
        title="思考档位"
        role={triggerRole}
        className={triggerClassName}
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((open) => !open);
        }}
      >
        {triggerIcon}
        <span>{triggerLabel ?? '思考档位'}</span>
      </button>
      {isOpen && (
        <div
          style={getPopoverStyle()}
          data-thread-action-popover="true"
          role="dialog"
          aria-label="对话思考档位"
          className="z-50 flex max-h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-xl border border-cafe bg-cafe-surface shadow-lg"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="border-b border-cafe-subtle px-3 py-2.5">
            <p className="text-xs font-semibold text-cafe-black">这个对话的思考额度</p>
            <p className="mt-0.5 text-micro text-cafe-muted">
              只覆盖本对话，从下一次回复生效；留空就跟随每只猫自己的默认设置。
            </p>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索猫猫..."
              className="mt-2 w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2.5 py-1.5 text-xs text-cafe-black outline-none focus:border-cafe-accent"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {isLoading && <p className="px-2 py-6 text-center text-xs text-cafe-muted">正在读取设置…</p>}
            {!isLoading && loadError && (
              <div className="px-2 py-5 text-center">
                <p className="text-xs text-conn-red-text">读取失败</p>
                <button type="button" className="mt-2 text-xs text-cafe-accent" onClick={() => void loadRows()}>
                  重试
                </button>
              </div>
            )}
            {!isLoading && !loadError && (
              <>
                <EffortGroup
                  title="本对话猫猫"
                  rows={participants}
                  savingCatId={savingCatId}
                  saveError={saveError}
                  onChange={saveEffort}
                />
                <EffortGroup
                  title="其他猫猫"
                  rows={others}
                  savingCatId={savingCatId}
                  saveError={saveError}
                  onChange={saveEffort}
                />
                {visibleRows.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-cafe-muted">没有匹配的猫猫</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EffortGroup({
  title,
  rows,
  savingCatId,
  saveError,
  onChange,
}: {
  title: string;
  rows: ThreadMemberEffortRow[];
  savingCatId: string | null;
  saveError: string | null;
  onChange: (row: ThreadMemberEffortRow, effort: CliEffortPreset | null) => Promise<void>;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-2 last:mb-0">
      <h3 className="px-2 pb-1 pt-1 text-micro font-semibold uppercase tracking-wide text-cafe-muted">{title}</h3>
      {rows.map((row) => {
        const catId = String(row.catId);
        const staleOverride =
          row.override && !row.options.includes(row.override) ? (row.override as CliEffortPreset) : null;
        return (
          <div key={catId} className="rounded-lg px-2 py-2 hover:bg-cafe-surface-elevated">
            <div className="flex items-center gap-2">
              <CatAvatar catId={catId} size={24} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-cafe-black">{row.displayName}</p>
                <p className="truncate text-micro text-cafe-muted">@{catId}</p>
              </div>
              <select
                data-cat-id={catId}
                value={row.override ?? ''}
                disabled={savingCatId === catId}
                onChange={(event) => {
                  const value = event.target.value;
                  void onChange(row, value ? (value as CliEffortPreset) : null);
                }}
                className="max-w-[170px] rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1 text-xs text-cafe-black outline-none focus:border-cafe-accent disabled:opacity-60"
              >
                <option value="">继承（{row.inherited}）</option>
                {staleOverride && <option value={staleOverride}>{staleOverride}（当前不可用）</option>}
                {row.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            {row.compatibility === 'incompatible' && row.override && (
              <p className="mt-1 text-micro text-conn-amber-text">
                当前模型不支持 {row.override}，暂按 {row.effective} 运行
              </p>
            )}
            {saveError === catId && <p className="mt-1 text-micro text-conn-red-text">保存失败，已恢复原设置</p>}
          </div>
        );
      })}
    </section>
  );
}
