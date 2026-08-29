'use client';

import { useState } from 'react';
import { MeetingCatWorkflowPicker } from './MeetingCatWorkflowPicker';

export interface MeetingRepairView {
  readonly code: string;
  readonly action: 'retry' | 'regrant' | 'manual_import';
  readonly safeDetail?: string;
}

interface MeetingIntakeRepairActionsProps {
  readonly repair: MeetingRepairView;
  readonly manualReference: string;
  readonly busy: boolean;
  readonly onManualReferenceChange: (value: string) => void;
  readonly onAction: (name: string, payload: Record<string, unknown>) => void;
  readonly revision: number;
  readonly routeCatRepair?: { readonly threadId: string };
  readonly onBindCatAndRetry?: (threadId: string, catId: string) => void;
}

export function MeetingIntakeRepairActions({
  repair,
  manualReference,
  busy,
  onManualReferenceChange,
  onAction,
  revision,
  routeCatRepair,
  onBindCatAndRetry,
}: MeetingIntakeRepairActionsProps) {
  const [catId, setCatId] = useState('');
  const needsCatBinding = repair.code === 'route_unavailable' && routeCatRepair && onBindCatAndRetry;

  return (
    <section
      className="space-y-3 rounded-md bg-[var(--semantic-warning-subtle)] p-3 text-micro"
      data-testid="meeting-repair"
    >
      <div>
        <p className="font-medium">{needsCatBinding ? '保存位置还没有负责整理的猫猫' : repairTitle(repair.action)}</p>
        <p className="mt-1 text-cafe-secondary">
          {needsCatBinding
            ? '选择一只当前可用的猫猫后会从失败处继续。已经填写的内容会保留，不需要重填。'
            : (repair.safeDetail ?? '已经填写的内容会保留，处理后可以在这里继续。')}
        </p>
      </div>

      {needsCatBinding && (
        <div className="space-y-2">
          <MeetingCatWorkflowPicker value={catId} disabled={busy} onChange={setCatId} />
          <button
            type="button"
            onClick={() => onBindCatAndRetry(routeCatRepair.threadId, catId)}
            disabled={busy || !catId}
            className="rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
            data-testid="meeting-bind-cat-retry"
          >
            {busy ? '正在继续…' : '保存负责猫猫并继续'}
          </button>
        </div>
      )}

      {repair.action === 'retry' && !needsCatBinding && (
        <button
          type="button"
          onClick={() => onAction('retry', { expectedRevision: revision })}
          disabled={busy}
          className="rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="meeting-retry"
        >
          再试一次
        </button>
      )}

      {repair.action === 'regrant' && (
        <div className="flex flex-wrap gap-2">
          <a
            href="/settings?s=plugins"
            className="inline-block rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 font-medium text-[var(--cafe-accent-foreground)]"
            data-testid="meeting-regrant"
          >
            重新连接飞书
          </a>
          <button
            type="button"
            onClick={() => onAction('retry', { expectedRevision: revision })}
            disabled={busy}
            className="rounded-md border border-[var(--semantic-warning)] px-3 py-1.5 font-medium disabled:opacity-50"
            data-testid="meeting-regrant-retry"
          >
            我已连接，再试一次
          </button>
        </div>
      )}

      {repair.action === 'manual_import' && (
        <div className="space-y-2">
          <input
            value={manualReference}
            onChange={(event) => onManualReferenceChange(event.target.value)}
            placeholder="粘贴飞书妙记链接或 token"
            className="w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm"
            data-testid="meeting-manual-reference"
          />
          <button
            type="button"
            onClick={() => onAction('manual-import', { expectedRevision: revision, reference: manualReference })}
            disabled={busy || !manualReference.trim()}
            className="rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
            data-testid="meeting-manual-import"
          >
            导入并开始整理
          </button>
        </div>
      )}
    </section>
  );
}

function repairTitle(action: MeetingRepairView['action']): string {
  if (action === 'regrant') return '飞书连接已失效';
  if (action === 'manual_import') return '原会议记录暂时无法读取';
  return '会议记录暂时还没准备好';
}
