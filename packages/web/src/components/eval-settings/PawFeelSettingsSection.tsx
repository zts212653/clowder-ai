'use client';

import { useState } from 'react';
import { PawFeelAuditSummary } from './PawFeelAuditSummary';
import { PawFeelDutyEditor } from './PawFeelDutyEditor';

export function PawFeelSettingsSection() {
  const [open, setOpen] = useState(false);

  return (
    <section
      className="rounded-xl border border-cafe bg-cafe-surface-elevated p-4"
      aria-label="爪感差责任闭环"
      data-testid="paw-feel-settings-section"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-cafe">爪感差责任闭环</h2>
          <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">
            Workspace 是唯一审阅工作台；这里仅管理责任值班，并展示同一 ledger 的紧凑审计摘要。
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="console-button-secondary w-fit px-3 py-1.5 text-xs"
        >
          {open ? '收起配置' : '查看值班与审计'}
        </button>
      </div>

      {open ? (
        <div className="mt-4 space-y-4">
          <PawFeelDutyEditor />
          <PawFeelAuditSummary />
        </div>
      ) : null}
    </section>
  );
}
