import type { MemoryOwnerSourceResponse } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ExternalLinkIcon } from '@/components/HubConfigIcons';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { isOwnerSource } from './owner-memory-read';
import type { MemoryOwnerActionState } from './use-memory-owner-action';
import { useMemoryRead } from './use-memory-read';

export function MemoryOwnerSource({ endpoint }: { endpoint: string }) {
  const source = useMemoryRead<MemoryOwnerSourceResponse>(endpoint, isOwnerSource);
  const router = useRouter();
  if (source.loading) return <p className="text-xs text-cafe-muted">正在读取来源…</p>;
  if (source.error || source.data?.status === 'unavailable')
    return (
      <p className="text-xs text-cafe-muted">
        来源暂时读不到{' '}
        <button type="button" className="underline" onClick={source.retry}>
          重读来源
        </button>
      </p>
    );
  if (source.data?.status === 'not_recorded') return <p className="text-xs text-cafe-muted">来源没有记录下来</p>;
  return (
    <div className="space-y-1 text-xs text-cafe-muted">
      {source.data?.sources.map((item, index) => (
        <div key={`${index}:${item.label}`}>
          <span>{item.label}</span>
          {item.canOpen && item.threadId && item.messageId && (
            <button
              type="button"
              className="ml-2 inline-flex items-center gap-1 text-cafe-accent underline"
              onClick={() => {
                if (!item.threadId || !item.messageId) return;
                handleTeleportEvent({ threadId: item.threadId, messageId: item.messageId }, null, {
                  pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
                  scrollToMessage,
                });
              }}
            >
              查看原消息
              <span aria-hidden="true">
                <ExternalLinkIcon />
              </span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
export function MemoryOwnerFeedback({ action, reread }: { action: MemoryOwnerActionState; reread: () => void }) {
  if (!action.error) return null;
  return (
    <div role="alert" className="space-y-2 text-compact">
      <p>{action.error}</p>
      {action.retryable ? (
        <button type="button" disabled={action.busy} onClick={action.retry} className="text-cafe-accent underline">
          重试这次操作
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            action.reset();
            reread();
          }}
          className="text-cafe-accent underline"
        >
          重读记忆
        </button>
      )}
    </div>
  );
}
export function MemoryForgetControl({
  revision,
  noun,
  action,
  retainedAudit = false,
  quiet = false,
}: {
  revision: string;
  noun: string;
  action: MemoryOwnerActionState;
  retainedAudit?: boolean;
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="space-y-3 text-compact">
      <button
        type="button"
        disabled={action.blocked}
        onClick={() => {
          setOpen(!open);
          setConfirmed(false);
        }}
        className={quiet ? 'shell-focusable text-cafe-muted' : 'text-cafe-accent underline'}
      >
        忘掉{noun}
      </button>
      {open && (
        <div className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4">
          <p>永久删除这条{noun}并使派生内容失效，不能撤销。记录时引用的原始消息或文档保留。</p>
          {retainedAudit && <p>不可变更的版本审计记录仍保留；这次遗忘不删除审计中的旧版本。</p>}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我确认永久遗忘
          </label>
          <button
            type="button"
            disabled={!confirmed || action.blocked}
            className="text-cafe-accent underline"
            onClick={() => action.submit({ action: 'hard_forget', expectedRevision: revision, confirmed: true })}
          >
            确认永久遗忘
          </button>
        </div>
      )}
    </div>
  );
}
