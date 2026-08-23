import type { InvocationTimelineRow } from './invocation-trajectory-model';
import { formatTrajectoryDuration } from './invocation-trajectory-ui';

type SemanticRole = 'user' | 'assistant' | 'system' | 'context' | 'tool' | 'error';

const ROLE_VISUAL: Record<SemanticRole, { label: string; frame: string; badge: string; surface: string }> = {
  user: {
    label: 'USER',
    frame: 'border-conn-blue-ring',
    badge: 'border-conn-blue-ring text-conn-blue-text',
    surface: 'var(--conn-blue-bubble-bg)',
  },
  assistant: {
    label: 'ASSISTANT',
    frame: 'border-conn-purple-ring',
    badge: 'border-conn-purple-ring text-conn-purple-text',
    surface: 'var(--conn-purple-bubble-bg)',
  },
  system: {
    label: 'SYSTEM',
    frame: 'border-conn-gray-ring',
    badge: 'border-conn-gray-ring text-conn-gray-text',
    surface: 'var(--conn-gray-bubble-bg)',
  },
  context: {
    label: 'CONTEXT',
    frame: 'border-conn-green-ring',
    badge: 'border-conn-green-ring text-conn-green-text',
    surface: 'var(--conn-green-bubble-bg)',
  },
  tool: {
    label: 'TOOL',
    frame: 'border-conn-amber-ring',
    badge: 'border-conn-amber-ring text-conn-amber-text',
    surface: 'var(--conn-amber-bubble-bg)',
  },
  error: {
    label: 'ERROR',
    frame: 'border-conn-red-ring',
    badge: 'border-conn-red-ring text-conn-red-text',
    surface: 'var(--conn-red-bubble-bg)',
  },
};

function SemanticIcon({ semanticRole }: { semanticRole: SemanticRole }) {
  const paths: Record<SemanticRole, React.ReactNode> = {
    user: <path d="M8 8a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 7a6 6 0 0 1 12 0" />,
    assistant: <path d="M2 2h12v9H7l-3 3v-3H2V2Zm3 3h.01M8 5h.01M11 5h.01" />,
    system: (
      <path d="M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.5 1.5m7 7L13 13M13 3l-1.5 1.5m-7 7L3 13M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
    ),
    context: <path d="M2 2h12v12H2V2Zm3 3h6M5 8h6m-6 3h4" />,
    tool: <path d="m10.5 2.5-3 3 3 3 3-3A4 4 0 0 1 8 10l-5 5-2-2 5-5a4 4 0 0 1 4.5-5.5Z" />,
    error: <path d="M8 1 15 14H1L8 1Zm0 4v4m0 2v.01" />,
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[semanticRole]}
    </svg>
  );
}

export function SemanticBadge({ semanticRole }: { semanticRole: SemanticRole }) {
  const visual = ROLE_VISUAL[semanticRole];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro font-semibold ${visual.badge}`}
    >
      <SemanticIcon semanticRole={semanticRole} />
      {visual.label}
    </span>
  );
}

export function SemanticFrame({
  semanticRole,
  tone = semanticRole,
  children,
}: {
  semanticRole: SemanticRole;
  tone?: SemanticRole;
  children: React.ReactNode;
}) {
  const visual = ROLE_VISUAL[tone];
  return (
    <div
      data-semantic-role={semanticRole}
      className={`rounded-xl border px-3 py-2.5 ${visual.frame}`}
      style={{
        backgroundImage: `linear-gradient(90deg, ${visual.surface} 0%, var(--cafe-surface-canvas) 52%)`,
        boxShadow: tone === 'error' ? 'inset 3px 0 0 var(--conn-red-text)' : undefined,
      }}
    >
      {children}
    </div>
  );
}

function sourceLabel(source: Extract<InvocationTimelineRow, { kind: 'tool' }>['source']): string {
  if (source === 'host_cli') return 'HOST CLI';
  if (source === 'mcp') return 'MCP';
  if (source === 'plugin_connector') return 'PLUGIN / CONNECTOR';
  return 'unknown';
}

function ToolRow({ row }: { row: Extract<InvocationTimelineRow, { kind: 'tool' }> }) {
  const resultStatus = row.resultStatus ?? (row.result !== undefined ? 'unknown' : 'running');
  return (
    <SemanticFrame semanticRole="tool" tone={resultStatus === 'error' ? 'error' : 'tool'}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <SemanticBadge semanticRole="tool" />
        <strong className="font-mono text-cafe">{row.toolName}</strong>
        <span className="rounded border border-cafe-subtle px-1.5 py-0.5 text-micro text-cafe-secondary">
          {sourceLabel(row.source)}
        </span>
        <span className="rounded border border-cafe-subtle px-1.5 py-0.5 text-micro text-cafe-secondary">
          {row.channel}
        </span>
        <span
          className={`ml-auto text-micro font-semibold ${resultStatus === 'error' ? 'text-conn-red-text' : 'text-cafe-muted'}`}
        >
          {resultStatus}
          {row.durationMs != null ? ` · ${formatTrajectoryDuration(row.durationMs)}` : ''}
        </span>
      </div>
      {(row.input !== undefined || row.result !== undefined) && (
        <details className="mt-2 border-t border-cafe-subtle pt-2">
          <summary className="cursor-pointer text-micro font-semibold text-conn-amber-text">查看输入与结果</summary>
          {row.input !== undefined && (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-micro text-cafe-secondary">
              {JSON.stringify(row.input, null, 2)}
            </pre>
          )}
          {row.result !== undefined && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-micro text-cafe-secondary">
              {row.result}
            </pre>
          )}
        </details>
      )}
    </SemanticFrame>
  );
}

export function SemanticTimelineRow({ row }: { row: InvocationTimelineRow }) {
  if (row.kind === 'status-group') {
    return (
      <SemanticFrame semanticRole="context">
        <details data-testid="status-event-fold">
          <summary className="cursor-pointer text-xs font-medium text-cafe-secondary">
            <span className="mr-2 inline-flex">
              <SemanticBadge semanticRole="context" />
            </span>
            状态流水已折叠 · {row.count} 条
          </summary>
          <div className="mt-2 flex flex-wrap gap-1 text-micro text-cafe-muted">
            {Object.entries(row.types).map(([type, count]) => (
              <span key={type} className="rounded bg-cafe-surface-elevated px-1.5 py-0.5">
                {type} {count}
              </span>
            ))}
          </div>
        </details>
      </SemanticFrame>
    );
  }
  if (row.kind === 'overflow') {
    return (
      <div className="rounded-lg border border-dashed border-cafe-subtle px-3 py-2 text-xs text-cafe-muted">
        已收起 {row.count} 条 ·{' '}
        {Object.entries(row.types)
          .map(([type, count]) => `${type} ${count}`)
          .join(' / ')}
      </div>
    );
  }
  if (row.kind === 'tool') return <ToolRow row={row} />;
  const role: SemanticRole =
    row.kind === 'error' ? 'error' : row.kind === 'session' ? 'context' : row.kind === 'message' ? row.role : 'system';
  const content = 'content' in row ? row.content : '';
  return (
    <SemanticFrame semanticRole={role}>
      <div className="flex items-start gap-2 text-xs text-cafe-secondary">
        <SemanticBadge semanticRole={role} />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{content}</span>
      </div>
      {row.kind === 'message' && row.role === 'assistant' && (row.fragmentCount ?? 1) > 1 && (
        <p className="mt-2 text-micro text-conn-purple-text">
          已合并 {row.fragmentCount} 个 stream fragments · append {row.appendCount ?? 0} / replace{' '}
          {row.replaceCount ?? 0}
        </p>
      )}
    </SemanticFrame>
  );
}
