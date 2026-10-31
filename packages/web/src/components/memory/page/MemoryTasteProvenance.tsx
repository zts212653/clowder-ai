import { ExternalLinkIcon } from '@/components/HubConfigIcons';
import { tasteTime } from './taste-format';
import { canOpenTasteSource, type TasteMemory, type TasteSource } from './taste-types';
import type { MemoryRead } from './use-memory-read';

export function TasteApprovalSummary({ entry }: { entry: TasteMemory }) {
  return (
    <section className="mt-5 border-t border-cafe-subtle pt-4">
      <h4 className="text-compact text-cafe-muted">对应审批</h4>
      <p className="mt-2 text-sm">
        {entry.approval?.status === 'approved'
          ? `已批准${entry.approval.approvedAt ? ` · ${tasteTime(entry.approval.approvedAt)}` : ' · 批准时间没有记录下来'}`
          : entry.approval?.status === 'not_recorded'
            ? '审批记录没有记录下来'
            : '暂时读不到审批记录'}
      </p>
      {entry.approval?.proposedAt && (
        <p className="mt-1 text-xs text-cafe-muted">提出于 {tasteTime(entry.approval.proposedAt)}</p>
      )}
    </section>
  );
}

export function TasteSourceLocation({ source, locate }: { source: MemoryRead<TasteSource>; locate: () => void }) {
  return (
    <section className="mt-5 border-t border-cafe-subtle pt-4">
      <h4 className="text-compact text-cafe-muted">出处</h4>
      <p className="mt-2 break-words text-sm">
        {source.loading
          ? '正在读取出处…'
          : source.error
            ? '暂时读不到出处'
            : source.data?.status === 'not_recorded'
              ? '原始对话没有记录下来'
              : source.data?.status === 'ready'
                ? source.data.title || '对话 · 标题没有记录下来'
                : '暂时读不到出处对话'}
      </p>
      {source.error && (
        <button type="button" onClick={source.retry} className="mt-2 text-compact text-cafe-accent underline">
          重读出处
        </button>
      )}
      {canOpenTasteSource(source.data) && !source.loading && !source.error && (
        <button
          type="button"
          onClick={locate}
          className="mt-2 inline-flex items-center gap-1 text-compact text-cafe-accent underline"
        >
          查看原消息
          <span aria-hidden="true">
            <ExternalLinkIcon />
          </span>
        </button>
      )}
    </section>
  );
}
