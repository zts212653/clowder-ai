'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';
import type { FreshnessCarrierSupport } from './message-disposition-presentation';

const DISPOSITION_LABEL: Record<MessageWorkDisposition, string> = {
  next_work: '排队',
  continue_current: '追加到当前回复',
};

interface MessageDispositionSelectorProps {
  controller: MessageDispositionPreferenceController;
  carrierSupport: FreshnessCarrierSupport;
}

/**
 * #1307 keeps the sending decision intentionally small: a global default plus
 * one opt-in append for this message. Carrier details stay at the receipt,
 * where the outcome can be durable and target-specific.
 */
export function MessageDispositionSelector({ controller, carrierSupport }: MessageDispositionSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const defaultDisposition = controller.snapshot.global ?? controller.snapshot.productDefault;
  const currentDisposition = controller.oneShot ?? defaultDisposition;
  const appendEligible = carrierSupport === 'exact';
  const appendUnavailable = currentDisposition === 'continue_current' && !appendEligible;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  const chooseGlobalDefault = async (disposition: MessageWorkDisposition) => {
    const saved = await controller.setGlobalPreference(disposition);
    if (saved) setOpen(false);
  };

  const chooseOneShotAppend = () => {
    controller.setOneShot('continue_current');
    setOpen(false);
  };

  const triggerLabel = useMemo(
    () =>
      controller.oneShot
        ? `本条：${DISPOSITION_LABEL[currentDisposition]}`
        : `默认：${DISPOSITION_LABEL[currentDisposition]}`,
    [controller.oneShot, currentDisposition],
  );

  return (
    <div ref={rootRef} className="relative px-4 pt-2" data-testid="message-disposition-selector">
      <button
        type="button"
        data-testid="message-disposition-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-full border border-cafe bg-cafe-surface px-2.5 py-1 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary"
        title="选择消息默认如何送达"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-cocreator-primary)]" aria-hidden />
        <span>{triggerLabel}</span>
        <span aria-hidden className="text-cafe-muted">
          {open ? '↑' : '↓'}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="消息投递方式"
          className="absolute bottom-full left-4 z-50 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-cafe bg-cafe-surface p-3 shadow-lg"
          data-testid="message-disposition-popover"
        >
          <div className="mb-2">
            <div className="text-sm font-semibold text-cafe-primary">默认消息投递方式</div>
            <p className="mt-1 text-xs leading-relaxed text-cafe-muted">
              排队不会打断当前回复；追加会在当前回复的安全边界交给 Agent。
            </p>
          </div>

          <div className="grid gap-2">
            {(['next_work', 'continue_current'] as const).map((disposition) => (
              <button
                key={disposition}
                type="button"
                data-disposition-option={disposition}
                aria-pressed={defaultDisposition === disposition}
                disabled={controller.loading}
                onClick={() => void chooseGlobalDefault(disposition)}
                className="flex items-start gap-2 rounded-xl border border-cafe px-3 py-2 text-left transition-colors hover:bg-cafe-surface-elevated disabled:cursor-wait disabled:opacity-60"
              >
                <span
                  className={`mt-1 h-2 w-2 flex-none rounded-full ${
                    defaultDisposition === disposition
                      ? 'bg-[var(--color-cocreator-primary)]'
                      : 'border border-[var(--console-border-strong)]'
                  }`}
                  aria-hidden
                />
                <span>
                  <span className="block text-sm font-medium text-cafe-primary">{DISPOSITION_LABEL[disposition]}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-cafe-muted">
                    {disposition === 'next_work'
                      ? '等当前回复结束后处理。'
                      : '在不打断当前回复的前提下尝试追加；不能追加时自动排队。'}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {defaultDisposition === 'next_work' && appendEligible && !controller.oneShot && (
            <button
              type="button"
              data-testid="append-current-reply"
              onClick={chooseOneShotAppend}
              className="mt-3 w-full rounded-xl border border-[var(--color-cocreator-primary)] px-3 py-2 text-sm font-medium text-[var(--color-cocreator-primary)] transition-colors hover:bg-[var(--color-cocreator-surface)]"
            >
              仅这条：追加到当前回复
            </button>
          )}

          {controller.oneShot && (
            <button
              type="button"
              data-testid="clear-one-shot-append"
              onClick={() => {
                controller.clearOneShot();
                setOpen(false);
              }}
              className="mt-3 text-xs font-medium text-cafe-secondary hover:text-cafe-primary hover:underline"
            >
              取消本条追加
            </button>
          )}

          {appendUnavailable && (
            <p className="mt-3 text-xs text-conn-amber-text">这条消息会排队，当前回复不会被打断。</p>
          )}
          {controller.error && <p className="mt-2 text-xs text-conn-red-text">{controller.error}</p>}
        </div>
      )}
    </div>
  );
}

export function messageDispositionLabel(disposition: MessageWorkDisposition): string {
  return DISPOSITION_LABEL[disposition];
}
