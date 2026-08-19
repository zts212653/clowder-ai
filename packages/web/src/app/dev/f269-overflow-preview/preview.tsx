'use client';

import { type ReactNode, useEffect } from 'react';
import type { ReplayEvent } from '@/lib/story-player/types';
import type { RichFileBlock } from '@/stores/chat-types';
import { F269_PREVIEW_CASES, type F269PreviewCaseId } from './cases';
import { LegacyFileBaseline, LegacySettingsBaseline, LegacyToolResultBaseline } from './legacy-baseline';

export const SETTINGS_META =
  '语义检索当前不可用：本地向量服务尚未完成初始化，最近一次重建还跳过了 184 条文档；请先核对模型、索引目录与重建日志，再决定是否重新执行全量索引。';

export const FILE_FIXTURE: RichFileBlock = {
  id: 'f269-file-name',
  kind: 'file',
  v: 1,
  url: '/uploads/f269-evidence.pdf',
  fileName: '2026-07-20_猫咖全前端长文本可恢复性审计_设计系统迁移建议_含中文与家庭表情序列_👨‍👩‍👧‍👦_最终复核版_v12.pdf',
  mimeType: 'application/pdf',
  fileSize: 8_431_227,
};

export const F269_TOOL_RESULT_FIXTURE = [
  'BEGIN_F269_TOOL_RESULT',
  ...Array.from(
    { length: 42 },
    (_, index) =>
      `record-${String(index + 1).padStart(2, '0')}: canonical tool output remains meaningful across this deliberately long evidence line.`,
  ),
  'F269_TAIL_SENTINEL_MUST_DISAPPEAR',
].join('\n');

export const TOOL_EVENT: ReplayEvent = {
  index: 0,
  type: 'tool_call',
  timestamp: 1_752_990_400_000,
  role: 'assistant',
  content: '',
  toolName: 'cat_cafe_read_invocation_detail',
  toolInput: JSON.stringify({ invocationId: 'inv_f269_visual_evidence' }),
  toolResult: F269_TOOL_RESULT_FIXTURE,
  toolIsError: false,
  catId: 'codex-sol',
  eventNo: 1,
};

function CurrentSurface({ caseId }: { caseId: F269PreviewCaseId }): ReactNode {
  if (caseId === 'settings-prose') {
    return (
      <div className="w-[440px]">
        <LegacySettingsBaseline title="Memory semantic recall" meta={SETTINGS_META} />
      </div>
    );
  }

  if (caseId === 'file-name') {
    return (
      <div className="w-[440px]">
        <LegacyFileBaseline fileName={FILE_FIXTURE.fileName} />
      </div>
    );
  }

  return (
    <div className="w-[680px] text-cafe">
      <LegacyToolResultBaseline toolName={TOOL_EVENT.toolName ?? 'Unknown Tool'} content={F269_TOOL_RESULT_FIXTURE} />
    </div>
  );
}

export function F269OverflowPreview({
  caseId,
  autoCapture = false,
}: {
  caseId: F269PreviewCaseId;
  autoCapture?: boolean;
}) {
  const preview = F269_PREVIEW_CASES.find((candidate) => candidate.id === caseId) ?? F269_PREVIEW_CASES[0];

  useEffect(() => {
    if (!autoCapture) return;

    const captureTimer = window.setTimeout(() => {
      window.postMessage({ type: 'screenshot-request', source: 'cat-cafe-preview' }, window.location.origin);
    }, 1_200);

    return () => {
      window.clearTimeout(captureTimer);
    };
  }, [autoCapture]);

  return (
    <main className="min-h-screen bg-[var(--cafe-surface)] px-8 py-7 text-cafe">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cafe-muted">
            <span>F269 Phase A baseline evidence</span>
            <span aria-hidden="true">·</span>
            <span>{preview.severity}</span>
          </div>
          <h1 className="text-xl font-bold text-cafe">{preview.label}</h1>
          <p className="font-mono text-xs text-cafe-secondary">{preview.ledgerRecordId}</p>
        </header>

        <nav aria-label="Evidence cases" className="flex flex-wrap gap-2">
          {F269_PREVIEW_CASES.map((candidate) => (
            <a
              key={candidate.id}
              href={`?case=${candidate.id}`}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                candidate.id === preview.id
                  ? 'border-cafe-accent bg-cafe-accent text-[var(--cafe-accent-foreground)]'
                  : 'border-cafe text-cafe-secondary hover:bg-cafe-surface-elevated'
              }`}
            >
              {candidate.severity} · {candidate.id}
            </a>
          ))}
        </nav>

        <section className="rounded-2xl border border-cafe bg-[var(--console-card-bg)] p-6 shadow-[0_16px_36px_rgba(43,33,26,0.08)]">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-sm font-bold text-cafe">Phase A baseline UI</h2>
            {caseId === 'tool-result' && (
              <p className="text-xs text-cafe-muted">Open the tool row to inspect the rendered result.</p>
            )}
          </div>
          <div
            data-testid="f269-preview-surface"
            data-ledger-record-id={preview.ledgerRecordId}
            className="flex min-h-40 items-center justify-center rounded-xl bg-cafe-surface-elevated p-8"
          >
            <CurrentSurface caseId={preview.id} />
          </div>
        </section>

        <aside className="grid gap-3 text-xs text-cafe-secondary md:grid-cols-2">
          <div className="rounded-xl border border-cafe p-4">
            <h2 className="mb-1 font-bold text-cafe">This frame proves</h2>
            <p>{preview.proves}</p>
          </div>
          <div className="rounded-xl border border-cafe p-4">
            <h2 className="mb-1 font-bold text-cafe">This frame does not prove</h2>
            <p>{preview.doesNotProve}</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
