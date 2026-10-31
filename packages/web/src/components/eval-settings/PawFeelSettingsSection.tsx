'use client';

import { useState } from 'react';
import { useEvalCopy } from '../eval-workspace/eval-workspace.shell-copy';
import { PawFeelAuditSummary } from './PawFeelAuditSummary';
import { PawFeelDutyEditor } from './PawFeelDutyEditor';

export function PawFeelSettingsSection() {
  const t = useEvalCopy();
  const [open, setOpen] = useState(false);

  return (
    <section
      className="rounded-xl border border-cafe bg-cafe-surface-elevated p-4"
      aria-label={t.pawSettingsTitle}
      data-testid="paw-feel-settings-section"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-cafe">{t.pawSettingsTitle}</h2>
          <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">{t.pawSettingsDescription}</p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="console-button-secondary w-fit px-3 py-1.5 text-xs"
        >
          {open ? t.collapseSettings : t.dutyAudit}
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
