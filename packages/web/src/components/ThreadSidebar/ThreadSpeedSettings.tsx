'use client';

import type { CodexSpeedValue, ThreadMemberSpeedListResponse, ThreadMemberSpeedRow } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ThreadSpeedSettingsGroup } from './ThreadSpeedSettingsGroup';

interface ThreadSpeedSettingsContentProps {
  threadId: string;
}

/** Embedded speed editor for the unified thread settings surface. */
export function ThreadSpeedSettingsContent({ threadId }: ThreadSpeedSettingsContentProps) {
  const [rows, setRows] = useState<ThreadMemberSpeedRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingCatId, setSavingCatId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const loadRows = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const response = await apiFetch(`/api/threads/${threadId}/members/speed`);
      if (!response.ok) throw new Error('load failed');
      const body = (await response.json()) as ThreadMemberSpeedListResponse;
      setRows(body.members);
    } catch {
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

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

  const saveSpeed = useCallback(
    async (row: ThreadMemberSpeedRow, next: CodexSpeedValue | null) => {
      const selected = next ?? row.inherited;
      const isCompatible = selected === null || row.options.includes(selected);
      const optimistic: ThreadMemberSpeedRow = {
        ...row,
        override: next,
        requested: isCompatible ? selected : null,
        source: next ? 'thread_override' : row.inherited ? 'member_default' : 'codex_default',
        compatibility: isCompatible ? 'compatible' : 'incompatible',
      };
      setSaveError(null);
      setSavingCatId(String(row.catId));
      setRows((current) => current?.map((item) => (item.catId === row.catId ? optimistic : item)) ?? current);
      try {
        const response = await apiFetch(`/api/threads/${threadId}/members/${row.catId}/speed`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speed: next }),
        });
        if (!response.ok) throw new Error('save failed');
        const saved = (await response.json()) as ThreadMemberSpeedRow;
        setRows((current) => current?.map((item) => (item.catId === row.catId ? saved : item)) ?? current);
      } catch {
        setRows((current) => current?.map((item) => (item.catId === row.catId ? row : item)) ?? current);
        setSaveError(String(row.catId));
      } finally {
        setSavingCatId(null);
      }
    },
    [threadId],
  );

  const participants = visibleRows.filter((row) => row.isParticipant);
  const others = visibleRows.filter((row) => !row.isParticipant);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-cafe-subtle px-3 py-2.5">
        <p className="text-xs font-semibold text-cafe-black">这个对话的 Codex 速度</p>
        <p className="mt-0.5 text-micro text-cafe-muted">
          只表示向 Codex 请求的档位，从下一次回复生效；留空就跟随成员默认或 Codex 设置。
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
            <ThreadSpeedSettingsGroup
              title="本对话猫猫"
              rows={participants}
              savingCatId={savingCatId}
              saveError={saveError}
              onChange={saveSpeed}
            />
            <ThreadSpeedSettingsGroup
              title="其他猫猫"
              rows={others}
              savingCatId={savingCatId}
              saveError={saveError}
              onChange={saveSpeed}
            />
            {visibleRows.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-cafe-muted">没有匹配的猫猫</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
