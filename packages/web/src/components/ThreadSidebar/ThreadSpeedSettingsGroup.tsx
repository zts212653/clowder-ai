'use client';

import type { CodexSpeedValue, ThreadMemberSpeedRow } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';

function speedLabel(speed: CodexSpeedValue): string {
  return speed === 'fast' ? 'Fast' : 'Standard';
}

function inheritedLabel(row: ThreadMemberSpeedRow): string {
  if (row.inherited) return `成员 ${speedLabel(row.inherited)}`;
  return 'Codex 设置';
}

export function ThreadSpeedSettingsGroup({
  title,
  rows,
  savingCatId,
  saveError,
  onChange,
}: {
  title: string;
  rows: ThreadMemberSpeedRow[];
  savingCatId: string | null;
  saveError: string | null;
  onChange: (row: ThreadMemberSpeedRow, speed: CodexSpeedValue | null) => Promise<void>;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-2 last:mb-0">
      <h3 className="px-2 pb-1 pt-1 text-micro font-semibold uppercase tracking-wide text-cafe-muted">{title}</h3>
      {rows.map((row) => {
        const catId = String(row.catId);
        const staleOverride = row.override && !row.options.includes(row.override) ? row.override : null;
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
                  void onChange(row, value ? (value as CodexSpeedValue) : null);
                }}
                className="max-w-[180px] rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1 text-xs text-cafe-black outline-none focus:border-cafe-accent disabled:opacity-60"
              >
                <option value="">继承（{inheritedLabel(row)}）</option>
                {staleOverride && <option value={staleOverride}>{speedLabel(staleOverride)}（当前不可用）</option>}
                {row.options.map((option) => (
                  <option key={option} value={option}>
                    {speedLabel(option)}
                  </option>
                ))}
              </select>
            </div>
            {row.compatibility === 'incompatible' && (
              <p className="mt-1 text-micro text-conn-amber-text">当前模型不能请求 Fast，本轮将继承 Codex 设置</p>
            )}
            {saveError === catId && <p className="mt-1 text-micro text-conn-red-text">保存失败，已恢复原设置</p>}
          </div>
        );
      })}
    </section>
  );
}
