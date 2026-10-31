import { useEffect, useRef } from 'react';

export function MentionHandlingConfirmation({
  count,
  scope,
  counts,
  busy,
  onConfirm,
  onCancel,
  personal,
}: {
  personal?: { title: string; description: string; confirm: string; cancel: string };
  count: number;
  scope: 'today' | 'week' | 'earlier' | 'all';
  counts: { week: number; earlier: number };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      ref={dialog}
      role="alertdialog"
      aria-label={personal?.title ?? '确认处理请求'}
      aria-modal="true"
      className="rounded-lg border p-3"
      style={{ borderColor: 'var(--shell-hairline)' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (!busy) onCancel();
        }
        if (e.key === 'Tab') {
          const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!buttons?.length) return;
          const target = e.shiftKey ? buttons[buttons.length - 1] : buttons[0];
          const edge = e.shiftKey ? buttons[0] : buttons[buttons.length - 1];
          if (document.activeElement === edge) {
            e.preventDefault();
            target?.focus();
          }
        }
      }}
    >
      {personal ? (
        <p className="mb-2 mt-0">{personal.description}</p>
      ) : (
        <p className="mb-2 mt-0">
          将{scope === 'all' ? '全部' : scope === 'today' ? '今天的' : scope === 'week' ? '最近七天的' : '更早的'}{' '}
          {count} 件 @你 请求标为已处理。{scope === 'all' ? `这周 ${counts.week} 件、更早 ${counts.earlier} 件。` : ''}
          记录保留在「已处理的」，可以撤销刚才的批量处理。
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
          disabled={busy}
          style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)', fontWeight: 600 }}
          data-testid={personal ? 'mailbox-mentions-ignore-confirm' : undefined}
          onClick={onConfirm}
        >
          {personal?.confirm ?? `确认处理 ${count} 件`}
        </button>
        <button
          type="button"
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
          disabled={busy}
          onClick={onCancel}
        >
          {personal?.cancel ?? '取消'}
        </button>
      </div>
    </div>
  );
}
