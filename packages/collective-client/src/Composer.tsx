import { type FormEvent, type ReactNode, useRef, useState } from 'react';

import type { DeliveryState } from './client-types.js';

export function Composer({
  placeholder,
  context,
  delivery,
  onClearContext,
  onSend,
  compact = false,
  children,
}: {
  readonly placeholder: string;
  readonly context?: string;
  readonly delivery: DeliveryState;
  readonly onClearContext?: () => void;
  readonly onSend: (body: string) => Promise<void>;
  readonly compact?: boolean;
  readonly children?: ReactNode;
}) {
  const [body, setBody] = useState('');
  const sending = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = body.trim();
    if (!value || sending.current) return;
    sending.current = true;
    try {
      await onSend(value);
      setBody('');
    } finally {
      sending.current = false;
    }
  };
  return (
    <form
      className={compact ? 'composer composer-compact' : 'composer'}
      onSubmit={(event) => void submit(event).catch(() => undefined)}
    >
      {context && (
        <p className="composer-context">
          {context}
          {onClearContext && (
            <button type="button" onClick={onClearContext} aria-label="取消当前回复或提到">
              ×
            </button>
          )}
        </p>
      )}
      {children}
      <div className="composer-box">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={placeholder}
          rows={compact ? 3 : 2}
          required
        />
        <button type="submit" disabled={delivery.kind === 'requesting' || body.trim().length === 0}>
          发送
        </button>
      </div>
      {delivery.kind !== 'idle' && <p className={`delivery-state delivery-${delivery.kind}`}>{delivery.label}</p>}
    </form>
  );
}
