import { useEffect, useState } from 'react';
import { openMailbox } from '@/components/shell/mailbox/mailbox-navigation';
import { MemoryPersonMaintenanceConfirm } from './MemoryPersonMaintenance';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

interface DeferredEntry {
  receiptId: string;
  revision: string;
  subject?: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  sourceCount: number;
  pendingAction?: 'forget';
  proposalId?: string;
  proposalSection?: 'pending' | 'history';
}
interface DeferredPage {
  entries: DeferredEntry[];
  nextCursor: string | null;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function isPage(v: unknown): v is DeferredPage {
  return (
    record(v) &&
    (v.nextCursor === null || typeof v.nextCursor === 'string') &&
    Array.isArray(v.entries) &&
    v.entries.every(
      (e) =>
        record(e) &&
        typeof e.receiptId === 'string' &&
        typeof e.revision === 'string' &&
        typeof e.state === 'string' &&
        typeof e.createdAt === 'number' &&
        typeof e.updatedAt === 'number' &&
        typeof e.sourceCount === 'number' &&
        (e.pendingAction === undefined || e.pendingAction === 'forget') &&
        (e.subject === undefined || typeof e.subject === 'string') &&
        (e.proposalId === undefined || typeof e.proposalId === 'string') &&
        (e.proposalSection === undefined || ['pending', 'history'].includes(String(e.proposalSection))),
    )
  );
}
const active = new Set(['awaiting_confirmation', 'deferred', 'claimed']);
const status: Record<string, string> = {
  awaiting_confirmation: '待确认',
  deferred: '暂存待整理',
  claimed: '正在整理',
  withdrawn: '已撤回的暂存记录（内容已清空）',
  not_actionable: '未采纳的暂存记录（内容已清空）',
  proposed: '已转为正式人物提议',
};
function DeferredRow({ item }: { item: DeferredEntry }) {
  const [action, setAction] = useState<'withdraw' | 'forget' | null>(null);
  const isActive = active.has(item.state);
  const pendingForget = item.pendingAction === 'forget';
  return (
    <article
      className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4"
      data-testid="deferred-person-row"
      data-receipt-id={item.receiptId}
    >
      {isActive && item.subject && <h3 className="break-words text-sm font-medium">{item.subject}</h3>}
      <p className="text-compact">{pendingForget ? '永久遗忘尚未完成' : (status[item.state] ?? '状态暂不可确认')}</p>
      <p className="text-xs text-cafe-muted">
        记录于 {formatMemoryDate(item.createdAt)}
        {isActive ? ` · 来源消息 ${item.sourceCount} 条` : ` · 更新于 ${formatMemoryDate(item.updatedAt)}`}
      </p>
      {item.state === 'proposed' ? (
        <div className="space-y-2 text-compact">
          <p>已生成正式人物提议，不能只删除暂存记录；请到原提议处理。</p>
          {item.proposalId && item.proposalSection ? (
            <button
              type="button"
              className="shell-focusable text-cafe-accent underline"
              onClick={() => openMailbox({ section: item.proposalSection ?? 'pending', proposalId: item.proposalId })}
            >
              前往原提议处理
            </button>
          ) : (
            <p className="text-xs text-cafe-muted">暂时无法定位原提议，请从小信箱查找处理记录。</p>
          )}
        </div>
      ) : (
        (isActive || ['withdrawn', 'not_actionable'].includes(item.state)) && (
          <div className="space-y-3">
            {isActive && (
              <MemoryPersonMaintenanceConfirm
                label="撤回"
                opened={action === 'withdraw'}
                onToggle={() => setAction(action === 'withdraw' ? null : 'withdraw')}
                draft={{ action: 'withdraw', receiptId: item.receiptId, expectedRevision: item.revision }}
                description="停止整理这条暂存线索并清空暂存内容，保留一条已撤回状态记录。不会删除原始对话；同一来源今后仍可能产生新提议。"
              />
            )}
            <MemoryPersonMaintenanceConfirm
              label={pendingForget ? '继续永久遗忘' : '永久遗忘'}
              opened={action === 'forget'}
              onToggle={() => setAction(action === 'forget' ? null : 'forget')}
              draft={{ action: 'forget', receiptId: item.receiptId, expectedRevision: item.revision }}
              description={
                pendingForget
                  ? '前次永久遗忘尚未完成。继续会完成这条暂存记录的清理，不能撤销；不会删除原始对话。'
                  : '彻底删除这条暂存记录和它仍持有的去重标记，不能撤销。不会删除原始对话；同一来源今后可能再次产生新的记忆提议。'
              }
            />
          </div>
        )
      )}
    </article>
  );
}
export function MemoryDeferredPeople() {
  const [cursor, setCursor] = useState('0');
  const [entries, setEntries] = useState<DeferredEntry[]>([]);
  const read = useMemoryRead<DeferredPage>(
    `/api/memory/people/deferred?cursor=${encodeURIComponent(cursor)}&limit=20`,
    isPage,
  );
  useEffect(() => {
    if (read.data)
      setEntries((previous) =>
        cursor === '0'
          ? (read.data?.entries ?? [])
          : [
              ...previous,
              ...(read.data?.entries.filter((e) => !previous.some((p) => p.receiptId === e.receiptId)) ?? []),
            ],
      );
  }, [read.data, cursor]);
  return (
    <section aria-label="暂存的人物线索" className="space-y-3 border-t border-cafe-subtle pt-4">
      <h2 className="text-base font-medium">暂存的人物线索</h2>
      <p className="text-compact text-cafe-muted">还没正式记住的线索，以及撤回后的状态记录。只给你看。</p>
      {read.loading && <output className="block text-compact text-cafe-muted">正在读取暂存条目…</output>}
      {entries.map((item) => (
        <DeferredRow key={`${item.receiptId}:${item.revision}`} item={item} />
      ))}
      {read.error && (
        <div role="alert" className="space-y-2 text-compact">
          <p>暂存条目暂时读不到，已读到的记录仍在。</p>
          <button type="button" className="shell-focusable text-cafe-accent underline" onClick={read.retry}>
            重试读取暂存条目
          </button>
        </div>
      )}
      {!read.loading && !read.error && !entries.length && read.data?.nextCursor === null && (
        <p className="text-compact text-cafe-muted">当前没有暂存的人物线索</p>
      )}
      {read.data?.nextCursor && (
        <button
          type="button"
          disabled={read.loading}
          className="shell-focusable text-compact text-cafe-accent underline"
          onClick={() => setCursor(read.data?.nextCursor ?? '0')}
        >
          读取更多暂存条目
        </button>
      )}
    </section>
  );
}
