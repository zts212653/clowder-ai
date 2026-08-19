interface LegacyFileBaselineProps {
  fileName: string;
  fileSizeLabel?: string;
}

interface LegacySettingsBaselineProps {
  title: string;
  meta: string;
}

interface LegacyToolResultBaselineProps {
  toolName: string;
  content: string;
}

interface LegacyApprovalBaselineProps {
  reason: string;
}

const singleLineClip = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** Frozen Phase A evidence. Do not replace with live production components. */
export function LegacyFileBaseline({ fileName, fileSizeLabel = '8.0 MB · PDF' }: LegacyFileBaselineProps) {
  return (
    <div
      data-f269-baseline-fixture="file-name"
      className="flex items-center gap-3 rounded-lg border border-cafe px-4 py-3"
    >
      <span aria-hidden="true" className="text-xl">
        📄
      </span>
      <div className="min-w-0 flex-1">
        <div style={singleLineClip} className="text-sm font-medium text-cafe">
          {fileName}
        </div>
        <p className="mt-1 text-xs text-cafe-muted">{fileSizeLabel}</p>
      </div>
    </div>
  );
}

/** Frozen Phase A evidence. Do not replace with live production components. */
export function LegacySettingsBaseline({ title, meta }: LegacySettingsBaselineProps) {
  return (
    <div
      data-f269-baseline-fixture="settings-prose"
      className="rounded-xl bg-[var(--console-card-bg)] px-4 py-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
    >
      <div style={singleLineClip} className="text-compact font-bold text-cafe">
        {title}
      </div>
      <div style={singleLineClip} className="mt-0.5 text-xs text-cafe-secondary">
        {meta}
      </div>
    </div>
  );
}

/** Frozen Phase A producer-loss evidence. Do not replace with the live Story Player. */
export function LegacyToolResultBaseline({ toolName, content }: LegacyToolResultBaselineProps) {
  const visible = content.slice(0, 2000);
  return (
    <div className="rounded-md border border-cafe bg-cafe-surface-elevated p-3 font-mono text-xs text-cafe">
      <p className="font-semibold text-cafe-accent">🔧 {toolName}</p>
      <p className="mt-2 opacity-50">Result:</p>
      <pre className="mt-1 max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded bg-cafe-surface-sunken p-2">
        {visible}
        {content.length > visible.length ? `...\n[${content.length - visible.length} chars truncated]` : ''}
      </pre>
    </div>
  );
}

/** Frozen Phase A approval evidence. Do not replace with the live ApprovalItemCard. */
export function LegacyApprovalBaseline({ reason }: LegacyApprovalBaselineProps) {
  return (
    <div data-f269-baseline-fixture="critical-text" className="rounded-lg border border-cafe p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-md bg-cafe-accent px-2 py-0.5 font-semibold text-[var(--cafe-accent-foreground)]">
          F128
        </span>
        <span className="text-cafe-muted">待审批</span>
      </div>
      <h3 className="mt-2 text-sm font-bold text-cafe">切换 Memory 召回数据源</h3>
      <p className="mt-3 text-sm leading-5 text-cafe-secondary" style={{ maxHeight: '2.5rem', overflow: 'hidden' }}>
        {reason}
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" className="rounded-md bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-white">
          批准
        </button>
        <button type="button" className="rounded-md border border-cafe px-3 py-1.5 text-xs font-semibold text-cafe">
          拒绝
        </button>
      </div>
    </div>
  );
}
