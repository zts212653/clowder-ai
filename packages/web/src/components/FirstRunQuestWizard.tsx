'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NativeGoalStep } from './first-run-quest/NativeGoalStep';
import { NativePartnerCard } from './first-run-quest/NativePartnerCard';
import { useNativeOnboarding } from './first-run-quest/useNativeOnboarding';

interface FirstRunQuestWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (threadId: string, catName: string) => void;
}

export function FirstRunQuestWizard({ open, onClose, onCreated }: FirstRunQuestWizardProps) {
  const setup = useNativeOnboarding(open, onCreated);
  const [step, setStep] = useState<'partners' | 'goal'>('partners');
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setStep('partners');
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  const { draft, loading, busy, error, errorStage } = setup;
  const selected = draft?.partners.filter((p) => p.selected) ?? [];
  const invalidSelection = selected.some((p) => invalid[p.id] || !p.form.displayName.trim());
  const available =
    draft?.partners.filter((p) => p.runtime.installed && (p.runtime.clientId !== 'acp' || p.runtime.acp)) ?? [];

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--console-overlay-medium)] px-3 py-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-setup-title"
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onClose();
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--console-border-soft)] px-6 py-5">
          <div>
            <p className="mb-2 text-xs text-cafe-muted">
              {step === 'partners' ? '1 / 2 · 配置伙伴' : '2 / 2 · 第一个小目标'}
            </p>
            <h2 id="native-setup-title" className="text-xl font-semibold">
              {step === 'partners' ? '把你的工具，变成一起做事的伙伴' : '一起完成一件小事'}
            </h2>
            <p className="mt-2 text-sm text-cafe-secondary">
              {step === 'partners'
                ? '已安装的工具会自动推荐。选择要加入的伙伴，模型和思考强度默认跟随工具。'
                : '从一个具体、可完成的目标开始。你可以改写内容，再交给伙伴。'}
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭伙伴配置"
            disabled={Boolean(busy)}
            onClick={onClose}
            className="min-h-10 min-w-10 rounded-lg text-xl text-cafe-muted hover:bg-[var(--console-hover-bg)]"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-conn-red-ring bg-conn-red-bg p-3 text-sm text-conn-red-text"
            >
              <p className="font-medium">{errorStage === 'discovery' ? '检测未完成' : '还没保存完成'}</p>
              <p className="mt-1">{error}</p>
              <p className="mt-1">
                {errorStage === 'discovery'
                  ? '暂时无法确认本机工具状态。请检查服务连接后重试，你的选择和目标会保留。'
                  : '已添加的伙伴会保留。再次保存会从中断处继续，不会重复添加。'}
              </p>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={errorStage === 'discovery' ? setup.reload : () => void setup.start()}
                className="mt-2 underline"
              >
                {errorStage === 'discovery' ? '重新检测' : '重试保存'}
              </button>
            </div>
          )}
          {loading ? (
            <p role="status" className="py-12 text-center text-cafe-muted">
              正在检测本机工具…
            </p>
          ) : errorStage === 'discovery' ? null : step === 'partners' ? (
            <div className="space-y-3">
              {!available.length && (
                <div className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
                  <p className="font-medium">还没有找到可用工具</p>
                  <p className="mt-2 leading-relaxed">
                    先安装并配置下面任意一种工具，就能加入第一位伙伴。完成后回来重新检测，也可以稍后再配置。
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {available.length
                    ? `发现 ${available.length} 种工具 · 已选择 ${selected.length} 位伙伴`
                    : '支持的工具'}
                </span>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={setup.reload}
                  className="min-h-10 text-cafe-accent"
                >
                  重新检测
                </button>
              </div>
              {draft?.partners.map((partner) => (
                <NativePartnerCard
                  key={partner.id}
                  partner={partner}
                  disabled={Boolean(busy)}
                  created={Boolean(draft.created[partner.id] || partner.existingId)}
                  patch={(change) => setup.patchPartner(partner.id, change)}
                  onValidityChange={(valid) =>
                    setInvalid((current) =>
                      current[partner.id] === !valid ? current : { ...current, [partner.id]: !valid },
                    )
                  }
                />
              ))}
              {available.length > 0 && !selected.length && (
                <p className="rounded-lg bg-cafe-surface-canvas p-4 text-sm text-cafe-secondary">
                  选择至少一位伙伴继续。已发现的工具可以随时加入。
                </p>
              )}
              <p className="pt-2 text-xs leading-relaxed text-cafe-muted">
                使用各工具已有的连接与登录配置；是否可正常调用，将在第一次真实对话中验证。以后可在“设置 →
                成员与运行时”继续调整。
              </p>
            </div>
          ) : (
            <NativeGoalStep
              selected={selected}
              lead={draft?.lead ?? ''}
              goal={draft?.goal ?? ''}
              busy={Boolean(busy)}
              patch={setup.patch}
            />
          )}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--console-border-soft)] px-6 py-4">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={step === 'goal' ? () => setStep('partners') : onClose}
            className="min-h-11 rounded-lg px-3 text-sm text-cafe-secondary"
          >
            {step === 'goal' ? '返回选择伙伴' : '稍后配置'}
          </button>
          <button
            type="button"
            aria-label={
              busy || (step === 'partners' ? `下一步 · 为 ${selected.length} 位伙伴设定小目标` : '保存伙伴，前往对话')
            }
            disabled={
              loading ||
              errorStage === 'discovery' ||
              Boolean(busy) ||
              !selected.length ||
              invalidSelection ||
              (step === 'goal' && !draft?.goal.trim())
            }
            onClick={step === 'partners' ? () => setStep('goal') : () => void setup.start()}
            className="min-h-11 rounded-xl bg-cafe-accent px-5 text-sm font-medium text-[var(--cafe-surface)] disabled:opacity-50"
          >
            <span role="status">
              {busy || (step === 'partners' ? `下一步 · 为 ${selected.length} 位伙伴设定小目标` : '保存伙伴，前往对话')}
            </span>
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
