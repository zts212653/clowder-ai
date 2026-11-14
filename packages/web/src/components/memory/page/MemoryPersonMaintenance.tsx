import { useEffect, useRef, useState } from 'react';
import { notifyMemoryChanged } from '@/hooks/memory-changed';
import { executePersonMaintenance, personMaintenanceUnknown } from './person-maintenance-execute';
import {
  type PersonMaintenanceDraft,
  rememberPersonMaintenance,
  usePendingPersonMaintenance,
} from './person-maintenance-recovery';

export function MemoryPersonMaintenanceConfirm({
  draft,
  label,
  description,
  disabled = false,
  opened,
  onToggle,
  onApplied,
}: {
  draft: PersonMaintenanceDraft;
  label: string;
  description: string;
  disabled?: boolean;
  opened: boolean;
  onToggle: () => void;
  onApplied?: () => void;
}) {
  const { owner, pending, busy } = usePendingPersonMaintenance();
  const [error, setError] = useState('');
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Authentication changes must clear the previous owner's transient message.
  useEffect(() => setError(''), [owner]);
  return (
    <>
      <button
        type="button"
        disabled={disabled || busy || !!pending}
        onClick={() => {
          setError('');
          onToggle();
        }}
        className="shell-focusable text-compact text-cafe-muted underline"
      >
        {label}
      </button>
      {opened && (
        <fieldset
          aria-label={`${label}确认`}
          className="space-y-3 rounded-lg bg-cafe-surface-sunken p-3 text-compact break-words"
        >
          <p>{description}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              className="shell-focusable text-cafe-accent underline"
              disabled={!owner || disabled || busy || !!pending}
              onClick={async () => {
                if (!owner) return;
                try {
                  const command = rememberPersonMaintenance(owner, draft);
                  const result = await executePersonMaintenance(owner, command);
                  if (currentOwner.current !== owner) return;
                  if (result.outcome === 'applied') {
                    onApplied?.();
                    onToggle();
                  } else setError(result.message);
                } catch {
                  setError('无法保留操作恢复坐标，请检查浏览器存储后重试；尚未提交。');
                }
              }}
            >
              确认{label}
            </button>
            <button
              type="button"
              className="shell-focusable text-cafe-muted"
              disabled={busy}
              onClick={() => {
                setError('');
                onToggle();
              }}
            >
              取消
            </button>
          </div>
          {error && (
            <div role="alert" className="space-y-2">
              <p>{error}</p>
              {!pending && (
                <button
                  type="button"
                  className="shell-focusable text-cafe-accent underline"
                  onClick={() => {
                    setError('');
                    onToggle();
                    notifyMemoryChanged();
                  }}
                >
                  重读后再决定
                </button>
              )}
            </div>
          )}
        </fieldset>
      )}
    </>
  );
}

export function MemoryPersonMaintenanceRecovery({
  changed,
  applied,
}: {
  changed: () => void;
  applied?: (action: string) => void;
}) {
  const { owner, pending, busy } = usePendingPersonMaintenance();
  const [note, setNote] = useState('');
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Authentication changes must clear the previous owner's transient message.
  useEffect(() => setNote(''), [owner]);
  return (
    <section aria-label="人物记忆操作结果" className="space-y-3 text-compact">
      {note && (
        <div className="space-y-2">
          <output className="block">{note}</output>
          <button type="button" className="shell-focusable text-cafe-accent underline" onClick={changed}>
            重读人物和暂存条目
          </button>
        </div>
      )}
      {pending && (
        <div className="space-y-2 rounded-lg bg-cafe-surface-sunken p-3">
          <output className="block">{busy ? '正在确认这次操作的结果…' : personMaintenanceUnknown}</output>
          <p className="text-xs text-cafe-muted">
            {pending.action === 'redact_item'
              ? '单条内容遗忘'
              : pending.action === 'withdraw'
                ? '暂存条目撤回'
                : '暂存条目永久遗忘'}
          </p>
          <details>
            <summary className="shell-focusable text-xs">操作对象</summary>
            <code className="break-all text-xs">
              {pending.action === 'redact_item' ? pending.item.id : pending.receiptId}
            </code>
          </details>
          <button
            type="button"
            disabled={!owner || busy}
            className="shell-focusable text-cafe-accent underline"
            onClick={async () => {
              if (!owner) return;
              const result = await executePersonMaintenance(owner, pending);
              if (currentOwner.current !== owner) return;
              setNote(result.message);
              if (result.outcome === 'applied') applied?.(pending.action);
            }}
          >
            重试这次操作
          </button>
        </div>
      )}
    </section>
  );
}
