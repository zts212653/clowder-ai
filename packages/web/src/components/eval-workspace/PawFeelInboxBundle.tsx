'use client';

import type { PawFeelReviewBundle } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { PawFeelInboxRow } from './PawFeelInboxRow';

const BASIS_LABELS: Record<PawFeelReviewBundle['basis'], string> = {
  message: '同一消息',
  turn_invocation: '同一轮调用',
  legacy_invocation: '历史调用',
  single_signal: '单条报告',
};

const STATE_LABELS: Record<string, string> = {
  new: '未看',
  seen: '已看',
  route_pending: '等待接单',
  routed: '已移交',
  closed: '已关闭',
  duplicate: '重复',
  no_action: '不修',
  fix: '已确认要修',
  signature_waiting: '等待独立签署',
  blocked: '显式阻塞',
};

const RESPONSIBILITY_LABELS: Record<PawFeelReviewBundle['responsibility']['state'], string> = {
  unreviewed: 'unreviewed',
  bound_in_repair: 'bound-in-repair',
  signature_waiting: 'signature-waiting',
  blocked: 'blocked',
  terminal: 'terminal',
};

export function PawFeelInboxBundle({ bundle }: { bundle: PawFeelReviewBundle }) {
  const [expanded, setExpanded] = useState(false);
  const representative = bundle.members[0];
  const stateSummary = useMemo(
    () =>
      Object.entries(bundle.stateCounts)
        .map(([state, count]) => `${STATE_LABELS[state] ?? state} ${count}`)
        .join(' · '),
    [bundle.stateCounts],
  );

  return (
    <article
      className="min-w-0 px-3 py-3 sm:px-4"
      data-testid="paw-feel-inbox-bundle"
      data-basis={bundle.basis}
      data-responsibility={bundle.responsibility.state}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-cafe">
            <span>
              {BASIS_LABELS[bundle.basis]} · {bundle.rawSignalCount} 条报告
            </span>
            <span
              className="rounded-full border border-current px-1.5 py-0.5 font-mono text-micro text-cafe-secondary"
              data-testid="paw-feel-responsibility-state"
            >
              {RESPONSIBILITY_LABELS[bundle.responsibility.state]}
              {!bundle.responsibility.validExit ? ' · 尚未形成有效出口' : ''}
            </span>
          </div>
          <div className="mt-1 truncate text-micro text-cafe-muted" title={stateSummary}>
            {stateSummary}
          </div>
        </div>
        {representative?.source.availability === 'available' ? (
          <a
            className="block min-w-0 max-w-full truncate text-xs font-medium text-cafe-secondary hover:underline sm:max-w-[52%] sm:text-right"
            href={representative.source.sourceHref}
            title={representative.source.preview}
          >
            {representative.source.preview}
          </a>
        ) : (
          <span className="text-micro text-conn-amber-text">原消息暂不可读</span>
        )}
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex items-center gap-1 text-xs font-medium text-cafe-secondary transition hover:text-cafe"
          aria-expanded={expanded}
        >
          {expanded ? '收起原始报告' : `展开 ${bundle.rawSignalCount} 条原始报告`}
          <ChevronIcon open={expanded} />
        </button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-2">
          {bundle.members.map((item) => (
            <PawFeelInboxRow key={item.disposition.signalId} item={item} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
