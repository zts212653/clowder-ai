'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffViewer } from './workspace/DiffViewer';

export function F257GovernanceChanges({ changes }: { changes: Array<Record<string, unknown>> }) {
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const close = useCallback(() => setSelected(null), []);

  if (changes.length === 0) return <p className="text-cafe-muted">本卡没有可执行动作。</p>;

  return (
    <>
      <ol className="space-y-2" data-testid="f257-governance-action-list">
        {changes.map((change, index) => {
          const impactSummary = changeImpactSummary(change);
          return (
            <li
              key={`${String(change.unitId ?? 'unit')}-${index}`}
              className="rounded-lg border border-cafe-subtle/40 bg-cafe-muted/35 p-3"
              data-testid="f257-governance-change"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-cafe-accent/10 px-2 py-0.5 font-semibold text-cafe-accent">
                    {actionLabel(change.action)}
                  </span>
                  <span className="font-mono font-semibold">{String(change.unitId ?? '未知段')}</span>
                </div>
                {change.reason != null && <p className="mt-1 break-words text-cafe-muted">{String(change.reason)}</p>}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-cafe-secondary">
                  {impactSummary !== null && <span>{impactSummary}</span>}
                  <button
                    type="button"
                    onClick={() => setSelected(change)}
                    className="rounded px-1 font-medium text-cafe-accent underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
                    data-testid="f257-governance-open-diff"
                  >
                    {changeDetailLabel()}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {selected && <GovernanceDiffDialog change={selected} onClose={close} />}
    </>
  );
}

function GovernanceDiffDialog({ change, onClose }: { change: Record<string, unknown>; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const comparisons = comparisonBlocks(change);
  const impactSummary = changeImpactSummary(change);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements the dialog close button and Escape key.
    <div
      role="presentation"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-6xl min-w-0 flex-col overflow-hidden rounded-2xl border border-cafe bg-[var(--console-card-bg)] shadow-2xl sm:max-h-[calc(100dvh-48px)]"
        data-testid="f257-governance-diff-dialog"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-cafe px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-cafe-muted">动作差异</p>
            <h2 id={titleId} className="mt-1 break-words text-lg font-bold text-cafe">
              {String(change.unitId ?? '未知段')} · {actionLabel(change.action)}
            </h2>
            {change.reason != null && (
              <p className="mt-1 break-words text-sm text-cafe-secondary">{String(change.reason)}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭动作差异"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-cafe-muted transition-colors hover:bg-[var(--console-modal-close-bg)] hover:text-cafe focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
          >
            ✕
          </button>
        </header>

        <div className="min-h-[60dvh] flex-1 space-y-4 overflow-auto p-4 sm:p-6">
          {comparisons.map((comparison) => (
            <section key={comparison.id} className="space-y-2">
              <h3 data-testid="f257-governance-comparison-label" className="text-sm font-semibold text-cafe">
                {comparison.label}
                <span className="ml-2 text-xs font-normal text-cafe-muted">
                  · {OPERATION_LABEL[comparison.operation]}
                </span>
              </h3>
              <DiffViewer
                diff={fullContentDiff(
                  comparison.path ?? `${String(change.unitId ?? 'unit')} · ${comparison.label}`,
                  comparison.before,
                  comparison.after,
                )}
                hideFileMeta={comparison.operation === 'runtime'}
                initialMode="split"
                wrapLines
                splitHeaders={{ before: '应用前', after: '应用后' }}
              />
            </section>
          ))}
          {impactSummary !== null && (
            <div className="rounded-lg border border-cafe-subtle/40 bg-cafe-muted/35 p-3 text-sm">{impactSummary}</div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/**
 * What the executor actually does to this artifact. sol delta @a525247dc: the
 * writer creates the body and hook.yaml but APPENDS to the existing registry,
 * and enable/disable/modify only touch the runtime store — rendering all of
 * them as empty→full hid exactly the 新增/修改 distinction lang asked for.
 */
type ArtifactOperation = 'create' | 'append' | 'runtime';

interface ComparisonBlock {
  id: string;
  label: string;
  /** Real repository path, or null when no file is involved / knowable. */
  path: string | null;
  operation: ArtifactOperation;
  before: string;
  after: string;
}

const OPERATION_LABEL: Record<ArtifactOperation, string> = {
  create: '新建文件',
  append: '在既有文件中追加注册项',
  runtime: '运行时状态（不写文件）',
};

export function comparisonBlocks(change: Record<string, unknown>): ComparisonBlock[] {
  const action = String(change.action ?? '');
  const beforeContent = stringField(change, 'beforeContent') ?? '';
  // sol delta @91aa4b428: only `add` carries an authoritative assetSlug — the
  // writer creates the directory from it. For an existing segment the change
  // carries hookId = manifest.id ("L4"), the registry says "l4-iron-laws", and
  // the directory on disk is "l4-五条铁律": three different values, none of them
  // derivable from the card. Print no path rather than a plausible wrong one.
  const assetSlug = stringField(change, 'assetSlug');
  const assetDir = assetSlug ? `assets/prompt-hooks/${assetSlug}` : null;

  const blocks = selectBlocks(change, action, beforeContent, assetSlug, assetDir);

  if (change.proposedCondition !== undefined) {
    blocks.push({
      id: 'condition',
      label: '触发条件',
      path: assetDir && `${assetDir}/hook.yaml`,
      operation: 'runtime',
      before: formatCondition(change.beforeCondition),
      after: formatCondition(change.proposedCondition),
    });
  }
  if (blocks.length === 0) {
    blocks.push({
      id: 'state',
      label: '状态',
      path: assetDir,
      operation: 'runtime',
      before: '当前状态',
      after: '应用提议后的状态',
    });
  }
  return blocks;
}

function selectBlocks(
  change: Record<string, unknown>,
  action: string,
  beforeContent: string,
  assetSlug: string | undefined,
  assetDir: string | null,
): ComparisonBlock[] {
  if (action === 'add' && assetSlug) return addArtifactBlocks(change, assetSlug);
  if (action === 'disable' || action === 'enable') return enablementBlocks(change, action, beforeContent, assetDir);
  const afterContent = firstStringField(change, ['proposedContent', 'targetContent']);
  if (afterContent === undefined) return [];
  return [
    {
      id: 'content',
      label: '段正文',
      path: assetDir,
      operation: 'runtime',
      before: beforeContent,
      after: afterContent,
    },
  ];
}

/** The three artifacts HarnessUnitDirectoryWriter actually writes for an add. */
function addArtifactBlocks(change: Record<string, unknown>, assetSlug: string): ComparisonBlock[] {
  const manifest = asRecord(change.manifest);
  const template = stringField(manifest, 'template') ?? 'content.md';
  return [
    {
      id: 'content',
      label: '段正文',
      path: `assets/prompt-hooks/${assetSlug}/${template}`,
      operation: 'create',
      before: '',
      after: stringField(change, 'content') ?? '',
    },
    {
      id: 'manifest',
      label: 'Hook 清单',
      path: `assets/prompt-hooks/${assetSlug}/hook.yaml`,
      operation: 'create',
      before: '',
      after: formatStructured(manifest),
    },
    {
      id: 'registry',
      label: '评估单元注册表',
      path: 'docs/harness-feedback/objectives/unit-evaluation-manifest.yaml',
      operation: 'append',
      before: '',
      after: formatStructured({
        unitId: String(change.unitId ?? '未知段'),
        hookId: assetSlug,
        unitState: 'evaluable',
        objectives: asRecords(change.objectives),
      }),
    },
  ];
}

/**
 * Enable/disable changes injection, never the body. sol @ ccd01dabf (P2-B):
 * `beforeEnabled` is authoritative and the executor does not reject a no-op,
 * so both sides are derived — a no-op then compares equal and reads as one.
 */
function enablementBlocks(
  change: Record<string, unknown>,
  action: string,
  beforeContent: string,
  assetDir: string | null,
): ComparisonBlock[] {
  return [
    {
      id: 'state',
      label: '启用状态',
      path: assetDir && `${assetDir}/hook.yaml`,
      operation: 'runtime',
      before: enablementLabel(change.beforeEnabled),
      after: enablementLabel(action === 'enable'),
    },
    {
      id: 'content',
      label: '段正文',
      path: assetDir,
      operation: 'runtime',
      before: beforeContent,
      after: beforeContent,
    },
  ];
}

function enablementLabel(value: unknown): string {
  if (typeof value !== 'boolean') return '（提案未声明当前启用状态）';
  return value ? '启用中，会注入' : '已停用，不注入';
}

/**
 * sol @ ccd01dabf (P2-C): lossless. The previous renderer dropped every
 * object/array value, so HookManifest.inputs / .variables silently vanished
 * from the approval diff. Structured indentation keeps it readable without
 * falling back to raw JSON.
 */
const AMBIGUOUS_SCALAR = /[\n\r\t#]|:\s|^\s|\s$|^$|^[-?:,[\]{}&*!|>'"%@`]|^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/i;

/**
 * sol delta @91aa4b428: String() on every scalar let a value containing a
 * newline or ": " become a new top-level key, and made the string "true"
 * indistinguishable from the boolean. Ambiguous scalars are JSON-quoted, which
 * is both reversible and valid YAML double-quoted style.
 */
function formatScalar(value: unknown): string {
  if (typeof value === 'string' && AMBIGUOUS_SCALAR.test(value)) return JSON.stringify(value);
  return String(value);
}

function formatStructured(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) =>
        item !== null && typeof item === 'object'
          ? `${pad}-\n${formatStructured(item, indent + 1)}`
          : `${pad}- ${formatScalar(item)}`,
      )
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}（空）`;
    return entries
      .map(([key, item]) =>
        item !== null && typeof item === 'object'
          ? `${pad}${key}:\n${formatStructured(item, indent + 1)}`
          : `${pad}${key}: ${formatScalar(item)}`,
      )
      .join('\n');
  }
  if (value === null || value === undefined) return `${pad}（未给出）`;
  return `${pad}${formatScalar(value)}`;
}

function changeImpactSummary(change: Record<string, unknown>): string | null {
  if (change.action === 'add') {
    const manifest = asRecord(change.manifest);
    const objectiveIds = asRecords(change.objectives).map((item) => String(item.objectiveId));
    return `新增到 ${objectiveIds.join('、') || '未知 Objective'}；注入位置 ${String(manifest.stage ?? '未知 stage')} / order ${String(manifest.order ?? '未知')}`;
  }
  if (change.action === 'disable' || change.action === 'enable') {
    const impact = asRecord(change.objectiveImpact);
    return `影响 Objective ${String(impact.objectiveId ?? '未知')}；动作后剩余成员段 ${String(impact.remainingMemberCount ?? '未知')} 个`;
  }
  if (change.action === 'rollback') {
    return `版本 v${String(change.sourceVersion ?? '未知')} → v${String(change.targetVersion ?? '未知')}`;
  }
  const contentChanged = stringField(change, 'proposedContent') !== undefined;
  const conditionChanged = change.proposedCondition !== undefined;
  if (contentChanged && conditionChanged) return '同时修改段内容与触发条件';
  if (conditionChanged) return '修改触发条件';
  return null;
}

/** operator 2026-09-10: every action entry opens the same thing — its diff. */
function changeDetailLabel(): string {
  return '查看差异';
}

function actionLabel(action: unknown): string {
  if (action === 'modify') return '修改';
  if (action === 'disable') return '禁用';
  if (action === 'enable') return '启用';
  if (action === 'rollback') return '回退';
  if (action === 'add') return '新增';
  return '未知动作';
}

function formatCondition(value: unknown): string {
  if (value == null) return '无附加触发条件';
  const condition = asRecord(value);
  const conditionRef = String(condition.conditionRef ?? '未知条件');
  const params = condition.params === undefined ? '' : `\n参数：${JSON.stringify(condition.params, null, 2)}`;
  return `条件：${conditionRef}${params}`;
}

export function fullContentDiff(path: string, before: string, after: string): string {
  const beforeLines = before ? before.split('\n') : [];
  const afterLines = after ? after.split('\n') : [];
  let commonPrefix = 0;
  while (
    commonPrefix < beforeLines.length &&
    commonPrefix < afterLines.length &&
    beforeLines[commonPrefix] === afterLines[commonPrefix]
  ) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < beforeLines.length - commonPrefix &&
    commonSuffix < afterLines.length - commonPrefix &&
    beforeLines[beforeLines.length - 1 - commonSuffix] === afterLines[afterLines.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }
  const beforeMiddleEnd = beforeLines.length - commonSuffix;
  const afterMiddleEnd = afterLines.length - commonSuffix;
  const lines = [
    ...beforeLines.slice(0, commonPrefix).map((line) => ` ${line}`),
    ...minimalLineDiff(
      beforeLines.slice(commonPrefix, beforeMiddleEnd),
      afterLines.slice(commonPrefix, afterMiddleEnd),
    ),
    ...beforeLines.slice(beforeMiddleEnd).map((line) => ` ${line}`),
  ];
  const beforeStart = beforeLines.length === 0 ? 0 : 1;
  const afterStart = afterLines.length === 0 ? 0 : 1;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${beforeStart},${beforeLines.length} +${afterStart},${afterLines.length} @@`,
    ...lines,
  ].join('\n');
}

const MAX_LINE_DIFF_CELLS = 250_000;

function minimalLineDiff(beforeLines: string[], afterLines: string[]): string[] {
  const rowWidth = afterLines.length + 1;
  const cellCount = (beforeLines.length + 1) * rowWidth;
  if (cellCount > MAX_LINE_DIFF_CELLS) {
    return [...beforeLines.map((line) => `-${line}`), ...afterLines.map((line) => `+${line}`)];
  }

  return renderMinimalLineDiff(
    beforeLines,
    afterLines,
    rowWidth,
    buildLcsLengthTable(beforeLines, afterLines, rowWidth),
  );
}

function buildLcsLengthTable(beforeLines: string[], afterLines: string[], rowWidth: number): Uint32Array {
  const lcsLengths = new Uint32Array((beforeLines.length + 1) * rowWidth);
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex--) {
      const cell = beforeIndex * rowWidth + afterIndex;
      lcsLengths[cell] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? lcsLengths[cell + rowWidth + 1] + 1
          : Math.max(lcsLengths[cell + rowWidth], lcsLengths[cell + 1]);
    }
  }
  return lcsLengths;
}

function renderMinimalLineDiff(
  beforeLines: string[],
  afterLines: string[],
  rowWidth: number,
  lcsLengths: Uint32Array,
): string[] {
  const lines: string[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      lines.push(` ${beforeLines[beforeIndex]}`);
      beforeIndex++;
      afterIndex++;
    } else if (
      lcsLengths[(beforeIndex + 1) * rowWidth + afterIndex] >= lcsLengths[beforeIndex * rowWidth + afterIndex + 1]
    ) {
      lines.push(`-${beforeLines[beforeIndex]}`);
      beforeIndex++;
    } else {
      lines.push(`+${afterLines[afterIndex]}`);
      afterIndex++;
    }
  }
  while (beforeIndex < beforeLines.length) lines.push(`-${beforeLines[beforeIndex++]}`);
  while (afterIndex < afterLines.length) lines.push(`+${afterLines[afterIndex++]}`);
  return lines;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined;
}

function firstStringField(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = stringField(value, field);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}
