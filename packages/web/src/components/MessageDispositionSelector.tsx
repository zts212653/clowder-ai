'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  MessageDispositionPreferenceController,
  MessageDispositionPreferenceScope,
} from '@/hooks/useMessageDispositionPreference';
import type { FreshnessCarrierSupport } from './message-disposition-presentation';

const DISPOSITION_LABEL: Record<MessageWorkDisposition, string> = {
  next_work: '排队等待',
  continue_current: '立即发送，引导回复',
};

const SOURCE_LABEL: Record<MessageDispositionPreferenceController['source'], string> = {
  once: '仅这一次',
  thread: '本 Thread',
  global: '全局默认',
  product: '产品默认',
};

const SCOPE_LABEL: Record<MessageDispositionPreferenceScope, string> = {
  once: '仅这一次',
  thread: '本 Thread',
  global: '全局默认',
};

interface MessageDispositionSelectorProps {
  controller: MessageDispositionPreferenceController;
  carrierSupport: FreshnessCarrierSupport;
}

export function MessageDispositionSelector({ controller, carrierSupport }: MessageDispositionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<MessageDispositionPreferenceScope>('once');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scopeOverride = useMemo(() => {
    if (scope === 'once') return controller.oneShot;
    if (scope === 'thread') return controller.snapshot.thread;
    return controller.snapshot.global;
  }, [controller, scope]);
  const inheritedEffective = useMemo(() => {
    if (scope === 'once') {
      return { disposition: controller.snapshot.effective, source: controller.snapshot.source };
    }
    if (scope === 'thread' && controller.snapshot.global) {
      return { disposition: controller.snapshot.global, source: 'global' as const };
    }
    return { disposition: controller.snapshot.productDefault, source: 'product' as const };
  }, [controller, scope]);
  const carrierCopy =
    carrierSupport === 'exact'
      ? undefined
      : carrierSupport === 'undeclared'
        ? '能力未声明，发送时将按队列处理'
        : '当前接入不支持引导当前回复，发送时将按队列处理';

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  const toggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    setShowOnboarding(nextOpen && !controller.snapshot.onboardingSeen);
    if (nextOpen && !controller.snapshot.onboardingSeen) {
      void controller.markOnboardingSeen();
    }
  };

  const choose = async (disposition: MessageWorkDisposition) => {
    if (scope === 'once') {
      controller.setOneShot(disposition);
      setOpen(false);
      return;
    }
    const saved = await controller.setPreference(scope, disposition);
    if (saved) setOpen(false);
  };

  const resetScope = async () => {
    if (scope === 'once') {
      controller.clearOneShot();
      setOpen(false);
      return;
    }
    const saved = await controller.setPreference(scope, null);
    if (saved) setOpen(false);
  };

  const hasOverride = scopeOverride !== null;

  return (
    <div ref={rootRef} className="relative px-4 pt-2" data-testid="message-disposition-selector">
      <button
        type="button"
        data-testid="message-disposition-trigger"
        data-disposition-source={controller.source}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded-full border border-cafe bg-cafe-surface px-2.5 py-1 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary"
        title="选择默认消息分发方式"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-cocreator-primary)]" aria-hidden />
        <span>{DISPOSITION_LABEL[controller.effective]}</span>
        <span aria-hidden className="text-cafe-muted">
          {open ? '↑' : '↓'}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择消息去向"
          className="absolute bottom-full left-4 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-cafe bg-cafe-surface p-2.5 shadow-lg"
          data-testid="message-disposition-popover"
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
            <div className="text-sm font-medium text-cafe-primary">发送方式</div>
            {controller.loading ? <span className="text-micro text-cafe-muted">同步中…</span> : null}
          </div>

          <fieldset className="mb-2 flex rounded-lg bg-cafe-surface-sunken p-0.5" aria-label="偏好作用域">
            {(Object.keys(SCOPE_LABEL) as MessageDispositionPreferenceScope[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                data-disposition-scope={candidate}
                aria-pressed={scope === candidate}
                onClick={() => setScope(candidate)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                  scope === candidate
                    ? 'bg-cafe-surface-elevated font-medium text-cafe-primary shadow-sm'
                    : 'text-cafe-muted hover:text-cafe-secondary'
                }`}
              >
                {SCOPE_LABEL[candidate]}
              </button>
            ))}
          </fieldset>

          <p className="mb-2 px-0.5 text-micro text-cafe-muted" data-testid="message-disposition-scope-state">
            {scopeOverride
              ? `已设置 · ${DISPOSITION_LABEL[scopeOverride]}`
              : `继承 ${SOURCE_LABEL[inheritedEffective.source]} · ${DISPOSITION_LABEL[inheritedEffective.disposition]}`}
          </p>

          <div className="overflow-hidden rounded-lg border border-cafe">
            {(['next_work', 'continue_current'] as const).map((disposition) => (
              <button
                key={disposition}
                type="button"
                data-disposition-option={disposition}
                aria-pressed={scopeOverride === disposition}
                disabled={controller.loading}
                onClick={() => void choose(disposition)}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors first:border-b first:border-cafe hover:bg-cafe-surface-elevated disabled:opacity-60 ${
                  scopeOverride === disposition ? 'bg-cafe-surface-sunken' : ''
                } ${controller.loading ? 'disabled:cursor-wait' : ''}`}
              >
                <span
                  className={`mt-1 h-2 w-2 flex-none rounded-full ${
                    scopeOverride === disposition
                      ? 'bg-[var(--color-cocreator-primary)]'
                      : 'border border-[var(--console-border-strong)]'
                  }`}
                  aria-hidden
                />
                <span className="text-sm font-medium text-cafe-primary">{DISPOSITION_LABEL[disposition]}</span>
              </button>
            ))}
          </div>

          {carrierCopy ? <p className="mt-2 px-0.5 text-micro text-conn-amber-text">{carrierCopy}</p> : null}
          {showOnboarding ? (
            <p className="mt-1 px-0.5 text-micro text-cafe-muted" data-testid="message-disposition-onboarding">
              选择可只用于本次，也可保存到 Thread 或全局。
            </p>
          ) : null}

          <div className="mt-1 flex min-h-5 items-center justify-between gap-2 px-0.5">
            <span className="text-micro text-conn-red-text">{controller.error}</span>
            {hasOverride && (
              <button
                type="button"
                onClick={() => void resetScope()}
                className="text-xs font-medium text-cafe-secondary hover:text-cafe-primary hover:underline"
              >
                恢复继承
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function messageDispositionLabel(disposition: MessageWorkDisposition): string {
  return DISPOSITION_LABEL[disposition];
}
