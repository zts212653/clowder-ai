'use client';

import {
  type CollectiveF290ExperienceWorkRef,
  collectiveF290ExperienceWorks,
  findCollectiveF290ExperienceWork,
} from '@cat-cafe/shared';
import { useState } from 'react';

export function F290HostExperiencePanel({
  open,
  activeWorkRef,
  resultPending,
  resultNotice,
  onClose,
  onOpenWork,
  onReturnResult,
}: {
  readonly open: boolean;
  readonly activeWorkRef?: CollectiveF290ExperienceWorkRef;
  readonly resultPending: boolean;
  readonly resultNotice?: string;
  readonly onClose: () => void;
  readonly onOpenWork: (workRef: CollectiveF290ExperienceWorkRef) => void;
  readonly onReturnResult: (workRef: CollectiveF290ExperienceWorkRef) => void;
}) {
  const [hasPrivateProposal, setHasPrivateProposal] = useState(false);
  if (!open) return null;
  const active = activeWorkRef ? findCollectiveF290ExperienceWork(activeWorkRef) : undefined;
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[340px] flex-col border-l border-[var(--console-border-soft)] bg-[var(--console-card-bg)] shadow-[var(--console-elevation-2)]"
      aria-label="我的 Café"
      data-testid="f290-host-cafe-panel"
    >
      <header className="flex items-start justify-between gap-4 border-b border-[var(--console-border-soft)] px-5 py-4">
        <div>
          <p className="text-xs font-semibold text-cafe-accent">体验候选 · 演示数据</p>
          <h2 className="mt-1 text-lg font-semibold text-cafe-primary">我的 Café</h2>
          <p className="mt-1 text-xs leading-5 text-cafe-muted">
            Host 私密渲染：这里没有把私人对话、Thread ID 或凭据交给 Collective Client。
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭我的 Café"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
        >
          ×
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
        <p className="text-sm leading-6 text-cafe-secondary">
          同一 Channel 的两项 Work 各自回到不同的家内现场；公共端只认识它们的 Work 引用与允许公开的状态。
        </p>
        {collectiveF290ExperienceWorks.map((work) => (
          <button
            key={work.ref}
            type="button"
            data-work-ref={work.ref}
            onClick={() => onOpenWork(work.ref)}
            className={`block w-full rounded-xl border p-3 text-left ${active?.ref === work.ref ? 'border-cafe-accent bg-[var(--cafe-surface-sunken)]' : 'border-[var(--console-border-soft)] hover:bg-[var(--console-hover-bg)]'}`}
          >
            <strong className="block text-sm text-cafe-primary">{work.title}</strong>
            <span className="mt-1 block text-xs text-cafe-secondary">
              {work.cat} · 私有施工现场 · {work.ref}
            </span>
          </button>
        ))}
        <section className="rounded-xl bg-[var(--cafe-surface-sunken)] p-3 text-sm text-cafe-secondary">
          <strong className="block text-cafe-primary">新事项</strong>
          <p className="mt-1 leading-5">
            这里可以提议一个新上下文；没有来源、Work 关系和 owner admission 时，不会猜最近 Thread 或自动建 Task。
          </p>
          <button
            type="button"
            onClick={() => setHasPrivateProposal(true)}
            className="mt-3 rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 text-sm font-medium hover:bg-[var(--console-hover-bg)]"
          >
            提出新事项草案
          </button>
          {hasPrivateProposal && (
            <p className="mt-2 text-xs leading-5 text-cafe-muted">已在我的 Café 保留新事项草案；尚未授权公开。</p>
          )}
        </section>
        {activeWorkRef && !active && (
          <p className="rounded-xl border border-[var(--console-border-soft)] p-3 text-sm text-cafe-secondary">
            这项 Work 已不在当前 Café 的可继续范围内。
          </p>
        )}
      </div>
      {active && (
        <footer className="border-t border-[var(--console-border-soft)] px-5 py-4">
          <p className="mb-3 text-xs leading-5 text-cafe-muted">
            当前在 {active.title} 的 Host 私人现场。公开回流只带这项 Work 的引用与“结果已准备好”。
          </p>
          {resultNotice && (
            <output className="mb-3 rounded-lg bg-[var(--cafe-surface-sunken)] px-3 py-2 text-xs leading-5 text-cafe-secondary">
              {resultNotice}
            </output>
          )}
          <button
            type="button"
            onClick={() => onReturnResult(active.ref)}
            disabled={resultPending}
            className="w-full rounded-lg bg-cafe-accent px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)]"
          >
            {resultPending ? '等待 Client 确认…' : '将公开结果带回原 Channel'}
          </button>
        </footer>
      )}
    </aside>
  );
}
