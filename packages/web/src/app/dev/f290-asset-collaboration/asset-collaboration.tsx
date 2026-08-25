'use client';

import { useState } from 'react';
import { WorkspaceSurfaceHeader } from '@/components/workspace/WorkspaceSurfaceHeader';
import { AssetDiscussion } from './asset-discussion';
import { AssetDocument } from './asset-document';
import { AssetEditing } from './asset-editing';
import { CollaborationRecords } from './collaboration-records';
import copy from './product-copy.json';

const MODES = [
  { id: 'read', label: '阅读', status: '正在阅读当前版本', recordId: 'final-4966794934' },
  { id: 'edit', label: '审阅修改', status: '正在审阅修改建议', recordId: 'partial-4965951215' },
  { id: 'discuss', label: '批注', status: '正在围绕原文讨论', recordId: 'review-4951812238' },
] as const;

export function F290AssetCollaboration() {
  const [mode, setMode] = useState<(typeof MODES)[number]>(MODES[0]);
  const [selectedRecordId, setSelectedRecordId] = useState<string>(mode.recordId);

  function selectMode(nextMode: (typeof MODES)[number]) {
    setMode(nextMode);
    setSelectedRecordId(nextMode.recordId);
  }

  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-3 text-cafe sm:p-5 lg:p-7">
      <section
        className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1440px] flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-[var(--console-shadow-soft)]"
        data-testid="asset-workspace"
        data-mode={mode.id}
      >
        <WorkspaceSurfaceHeader
          title="资产协作"
          detail={`${copy.asset.title} · ${copy.asset.version}`}
          active
          actions={<span className="text-micro text-cafe-muted">已同步</span>}
        />

        <nav
          className="flex items-center gap-1 border-b border-cafe-subtle bg-cafe-surface px-3 py-2"
          aria-label="工作方式"
        >
          <div className="flex rounded-xl bg-cafe-surface-sunken p-1">
            {MODES.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => selectMode(candidate)}
                aria-pressed={candidate.id === mode.id}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  candidate.id === mode.id
                    ? 'bg-cafe-interactive text-[var(--cafe-accent-foreground)] shadow-sm'
                    : 'text-cafe-muted hover:text-cafe-secondary'
                }`}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <span className="ml-2 hidden text-micro font-medium text-cafe-muted sm:inline">{mode.status}</span>
          <span className="ml-auto rounded-full border border-cafe-subtle px-2.5 py-1 text-micro text-cafe-muted">
            2 人协作中
          </span>
        </nav>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_350px]">
          <div
            className={`min-h-[680px] overflow-y-auto transition-all ${
              mode.id === 'read'
                ? 'bg-cafe-surface'
                : mode.id === 'edit'
                  ? 'border-inset border-2 border-cafe-interactive/25 bg-cafe-surface-elevated'
                  : 'bg-cafe-surface-sunken/45'
            }`}
          >
            {mode.id === 'read' && <AssetDocument />}
            {mode.id === 'edit' && <AssetEditing />}
            {mode.id === 'discuss' && <AssetDiscussion />}
          </div>
          <CollaborationRecords selectedId={selectedRecordId} onSelect={setSelectedRecordId} />
        </div>
      </section>
    </main>
  );
}
