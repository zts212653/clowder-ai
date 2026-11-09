'use client';
import type { MatterMutationReceipt, MemoryMatter } from '@cat-cafe/shared';
import { useState } from 'react';
import { useMatterMutation } from './use-matter-mutation';

export function MemoryMatterActions({
  matter,
  onChanged,
}: {
  matter: Pick<MemoryMatter, 'matterId' | 'revision' | 'status'>;
  onChanged: (receipt: MatterMutationReceipt) => void;
}) {
  const [confirm, setConfirm] = useState<'retire' | 'forget' | null>(null);
  const action = useMatterMutation((receipt) => {
    setConfirm(null);
    onChanged(receipt);
  });
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-4 text-cafe-muted">
        {matter.status === 'active' && (
          <button
            type="button"
            className="shell-focusable hover:underline"
            disabled={action.busy}
            onClick={() => setConfirm('retire')}
          >
            不再使用
          </button>
        )}
        <button
          type="button"
          className="shell-focusable hover:underline"
          disabled={action.busy}
          onClick={() => setConfirm('forget')}
        >
          忘记这件事
        </button>
      </div>
      {confirm && (
        <div className="rounded-lg border border-cafe-subtle p-3">
          <p className="mb-2 text-cafe-muted">
            {confirm === 'forget'
              ? '清除这页及其来源关联，原消息会保留。此操作无法撤销。'
              : '停止用于新的回看，保留记录与来源。'}
          </p>
          <button
            type="button"
            className="shell-focusable mr-4 text-cafe-accent underline"
            disabled={action.busy}
            onClick={() =>
              action.submit({ operation: confirm, matterId: matter.matterId, expectedRevision: matter.revision })
            }
          >
            确认{confirm === 'forget' ? '忘记' : '不再使用'}
          </button>
          <button type="button" className="shell-focusable text-cafe-muted" onClick={() => setConfirm(null)}>
            取消
          </button>
        </div>
      )}
      {action.error && (
        <p role="alert">
          {action.error}{' '}
          {action.retryable && (
            <button type="button" className="underline" onClick={() => void action.retry()}>
              重试
            </button>
          )}
        </p>
      )}
    </div>
  );
}
