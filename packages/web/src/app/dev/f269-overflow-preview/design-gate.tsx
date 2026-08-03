'use client';

import { useState } from 'react';
import { ToastCard } from '@/components/ToastContainer';
import type { ToastItem } from '@/stores/toastStore';
import { DESIGN_PATTERNS } from './design-gate-patterns';
import { MissionControlRecoveryPreview } from './mission-control-preview';
import { SessionAuditRecoveryPreview } from './session-audit-preview';

const PRODUCT_STATES = [
  ['短内容', '完整显示，不出现多余控制'],
  ['真溢出', '按语义展开、阅读或复制'],
  ['只有 preview', '明示已截断，并跳 canonical source'],
  ['全文已丢失', '显示信息缺失，不制造假展开'],
] as const;

const SHORT_SUCCESS_TOAST: ToastItem = {
  id: 'f269-visual-restraint-short-toast',
  type: 'success',
  title: '砚砚处理完成',
  message: '已完成本轮代码检查',
  duration: 0,
  createdAt: 1_754_915_200_000,
};

function VisualRestraintToastPreview() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return <ToastCard toast={SHORT_SUCCESS_TOAST} onDismiss={() => setVisible(false)} />;
}

export function F269DesignGatePreview() {
  return (
    <main className="min-h-screen bg-[var(--cafe-surface)] px-4 py-8 text-cafe sm:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="overflow-hidden rounded-3xl border border-cafe bg-[var(--console-card-bg)] shadow-[0_20px_50px_rgba(43,33,26,0.08)]">
          <div className="grid gap-7 p-6 lg:grid-cols-[1.35fr_0.65fr] lg:p-9">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-cafe-accent">
                F269 · Phase B Design Gate
              </p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight text-cafe sm:text-4xl">省略号不再是信息终点</h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-cafe-secondary sm:text-base">
                这次不是“把审计做完”，而是给全前端一套用户真的能找回全文的默认交互。下面四组都使用 Clowder AI 真实 token
                和真实长文本形态；已完成迁移的旧态由冻结的 Phase A fixture 保留，不会随生产组件漂移。
              </p>
              <div className="mt-5 flex flex-wrap gap-2 text-xs font-semibold text-cafe-secondary">
                {['桌面 + 窄屏', '鼠标 + 触屏', 'Enter / Space', 'CJK + emoji'].map((label) => (
                  <span key={label} className="rounded-full border border-cafe bg-cafe-surface-elevated px-3 py-1.5">
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <aside className="rounded-2xl bg-cafe-surface-elevated p-5">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-cafe-muted">Product state matrix</p>
              <dl className="mt-4 space-y-3">
                {PRODUCT_STATES.map(([state, behavior]) => (
                  <div key={state} className="grid grid-cols-[5.5rem_1fr] gap-3 text-xs leading-5">
                    <dt className="font-bold text-cafe">{state}</dt>
                    <dd className="text-cafe-secondary">{behavior}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </div>
        </header>

        <section aria-label="Four recoverable overflow patterns" className="space-y-6">
          {DESIGN_PATTERNS.map((pattern) => (
            <article
              key={pattern.id}
              data-pattern={pattern.id}
              data-ledger-record-id={pattern.ledgerRecordId}
              className="rounded-3xl border border-cafe bg-[var(--console-card-bg)] p-5 shadow-[0_12px_32px_rgba(43,33,26,0.05)] sm:p-7"
            >
              <div className="grid gap-4 sm:grid-cols-[3rem_1fr]">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cafe-accent text-sm font-bold text-[var(--cafe-accent-foreground)]">
                  {pattern.index}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-cafe">{pattern.title}</h2>
                  <p className="mt-1 text-sm leading-6 text-cafe-secondary">{pattern.decision}</p>
                  <p className="mt-2 break-all font-mono text-micro text-cafe-muted">{pattern.ledgerRecordId}</p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <div className="min-w-0 rounded-2xl border border-cafe bg-cafe-surface-elevated p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-cafe-muted">
                      Phase A baseline · 信息死路
                    </h3>
                    <span className="rounded-full bg-conn-red-bg/40 px-2 py-1 text-micro font-semibold text-conn-red-text">
                      no recovery
                    </span>
                  </div>
                  <div className="min-w-0">{pattern.current}</div>
                </div>
                <div className="min-w-0 rounded-2xl border border-cafe-accent/30 bg-cafe-accent/[0.035] p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-cafe-accent">目标 · 全文可达</h3>
                    <span className="rounded-full bg-cafe-accent/10 px-2 py-1 text-micro font-semibold text-cafe-accent">
                      recoverable
                    </span>
                  </div>
                  <div className="min-w-0">{pattern.target}</div>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section
          data-testid="f269-visual-restraint"
          className="rounded-3xl border border-cafe bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow-soft)] sm:p-7"
        >
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cafe-accent">
            Post-gate correction · visual restraint
          </p>
          <div className="mt-3 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <h2 className="text-lg font-bold text-cafe">恢复能力不再自带一张卡</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-cafe-secondary">
                已有卡片、列表行与通知沿用原有界面层级；短内容没有额外按钮、背景或边框。只有真实溢出时，才增加低强调的全文入口。
              </p>
            </div>
            <div className="w-full max-w-xs">
              <VisualRestraintToastPreview />
            </div>
          </div>
        </section>

        <SessionAuditRecoveryPreview />
        <MissionControlRecoveryPreview />

        <footer className="rounded-2xl border border-cafe-accent/30 bg-cafe-accent/[0.06] p-5 text-sm leading-6 text-cafe-secondary">
          <strong className="text-cafe">Design Gate：</strong>
          四种交互已经成为咱们家的默认规则；Phase C 正在按 Ledger 将 U0 / U1 / U2 逐项迁移并验证全文可达。
        </footer>
      </div>
    </main>
  );
}
