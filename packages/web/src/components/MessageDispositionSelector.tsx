'use client';

import type { FreshnessCarrierCapability, MessageWorkDisposition } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  MessageDispositionPreferenceController,
  MessageDispositionPreferenceScope,
} from '@/hooks/useMessageDispositionPreference';
import {
  carrierCapabilityLabel,
  type FreshnessCarrierSupport,
  unsupportedCarrierCopy,
} from './message-disposition-presentation';

const DISPOSITION_LABEL: Record<MessageWorkDisposition, string> = {
  next_work: '下一件工作',
  continue_current: '接着当前工作',
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
  carrierCapabilities: readonly (FreshnessCarrierCapability | undefined)[];
}

export function MessageDispositionSelector({
  controller,
  carrierSupport,
  carrierCapabilities,
}: MessageDispositionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<MessageDispositionPreferenceScope>('once');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedForScope = useMemo(() => {
    if (scope === 'once') return controller.oneShot ?? controller.effective;
    if (scope === 'thread') return controller.snapshot.thread ?? controller.effective;
    return controller.snapshot.global ?? controller.snapshot.productDefault;
  }, [controller, scope]);
  const displayedDisposition =
    controller.effective === 'continue_current' && carrierSupport !== 'exact' ? 'next_work' : controller.effective;
  const carrierCopy = unsupportedCarrierCopy(carrierSupport);

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

  const hasOverride =
    scope === 'once'
      ? controller.oneShot !== null
      : scope === 'thread'
        ? controller.snapshot.thread !== null
        : controller.snapshot.global !== null;

  return (
    <div ref={rootRef} className="relative px-4 pt-2" data-testid="message-disposition-selector">
      <button
        type="button"
        data-testid="message-disposition-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded-full border border-cafe bg-cafe-surface px-2.5 py-1 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary"
        title="选择这条消息进入当前工作，还是成为下一件工作"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-cocreator-primary)]" aria-hidden />
        <span>{DISPOSITION_LABEL[displayedDisposition]}</span>
        <span className="text-cafe-muted">· {SOURCE_LABEL[controller.source]}</span>
        <span aria-hidden className="text-cafe-muted">
          {open ? '↑' : '↓'}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择消息去向"
          className="absolute bottom-full left-4 z-50 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-cafe bg-cafe-surface p-3 shadow-lg"
          data-testid="message-disposition-popover"
        >
          <div className="mb-2">
            <div className="text-sm font-semibold text-cafe-primary">这条消息要去哪？</div>
            <p className="mt-1 text-micro text-cafe-muted" data-provider-carrier-capability>
              {carrierCapabilities.length > 0
                ? carrierCapabilities.map(carrierCapabilityLabel).join('；')
                : carrierCapabilityLabel(undefined)}
            </p>
            {carrierCopy && <p className="mt-1 text-xs text-conn-amber-text">{carrierCopy}</p>}
            {showOnboarding && (
              <p
                className="mt-1 text-xs leading-relaxed text-cafe-secondary"
                data-testid="message-disposition-onboarding"
              >
                “下一件工作”会等当前轮结束；“接着当前工作”允许当前轮在安全断点读取，但不等于已经读到。
              </p>
            )}
          </div>

          <fieldset className="mb-2 flex rounded-xl bg-cafe-surface-sunken p-1" aria-label="偏好作用域">
            {(Object.keys(SCOPE_LABEL) as MessageDispositionPreferenceScope[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                data-disposition-scope={candidate}
                aria-pressed={scope === candidate}
                onClick={() => setScope(candidate)}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  scope === candidate
                    ? 'bg-cafe-surface-elevated font-medium text-cafe-primary shadow-sm'
                    : 'text-cafe-muted hover:text-cafe-secondary'
                }`}
              >
                {SCOPE_LABEL[candidate]}
              </button>
            ))}
          </fieldset>

          <div className="grid gap-2">
            {(['next_work', 'continue_current'] as const).map((disposition) => (
              <button
                key={disposition}
                type="button"
                data-disposition-option={disposition}
                aria-pressed={selectedForScope === disposition}
                disabled={controller.loading || (disposition === 'continue_current' && carrierSupport !== 'exact')}
                onClick={() => void choose(disposition)}
                className="flex items-start gap-2 rounded-xl border border-cafe px-3 py-2 text-left transition-colors hover:bg-cafe-surface-elevated disabled:cursor-wait disabled:opacity-60"
              >
                <span
                  className={`mt-1 h-2 w-2 flex-none rounded-full ${
                    (
                      selectedForScope === 'continue_current' && carrierSupport !== 'exact'
                        ? disposition === 'next_work'
                        : selectedForScope === disposition
                    )
                      ? 'bg-[var(--color-cocreator-primary)]'
                      : 'border border-[var(--console-border-strong)]'
                  }`}
                  aria-hidden
                />
                <span>
                  <span className="block text-sm font-medium text-cafe-primary">{DISPOSITION_LABEL[disposition]}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-cafe-muted">
                    {disposition === 'next_work'
                      ? '当前轮不可见；当前轮结束后自然开始。'
                      : carrierSupport === 'exact'
                        ? '等待本轮在 provider safe-boundary 精确读取；未读到会自动转成下一件工作。'
                        : carrierCopy}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="mt-2 flex min-h-5 items-center justify-between gap-2">
            <span className="text-micro text-cafe-muted">
              {controller.loading ? '正在同步偏好…' : controller.error}
            </span>
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
