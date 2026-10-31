'use client';

import { useShellPresentation } from '@/components/shell/shell-presentation';
import typographyTokens from '@/styles/typography-tokens.json';
import { AgentPaneListV2 } from './AgentPaneListV2';
import { type AgentPane, useAgentPanes } from './useAgentPanes';

export interface AgentPaneSelectionMeta {
  invocationId: string;
  catId: string | null;
}

interface AgentPaneListProps {
  worktreeId: string;
  onSelectPane: (paneId: string, meta?: AgentPaneSelectionMeta) => void;
  selectedPaneId?: string;
}

function AgentPaneListClassic({ worktreeId, onSelectPane, selectedPaneId }: AgentPaneListProps) {
  const panes = useAgentPanes(worktreeId);

  if (panes.length === 0) return null;

  const statusColor = (s: AgentPane['status']) =>
    s === 'running'
      ? 'var(--terminal-status-ok)'
      : s === 'crashed'
        ? 'var(--terminal-status-error)'
        : 'var(--terminal-text-muted)';
  const statusLabel = (s: AgentPane['status']) => (s === 'running' ? 'Running' : s === 'crashed' ? 'Crashed' : 'Done');

  return (
    <div style={{ borderBottom: '1px solid var(--terminal-chrome)', padding: '4px 0' }}>
      <div
        style={{
          padding: '2px 8px',
          fontSize: typographyTokens.fontSizePx.label,
          color: 'var(--terminal-text-dim)',
          fontWeight: 600,
        }}
      >
        Agent Panes
      </div>
      {panes.map((p) => (
        <button
          key={p.invocationId}
          type="button"
          onClick={() => onSelectPane(p.paneId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '4px 8px',
            fontSize: typographyTokens.fontSizePx.xs,
            background: selectedPaneId === p.paneId ? 'var(--terminal-chrome)' : 'transparent',
            border: 'none',
            color: 'var(--terminal-fg)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: statusColor(p.status),
              flexShrink: 0,
            }}
          />
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {p.invocationId.slice(0, 8)}
          </span>
          <span style={{ fontSize: typographyTokens.fontSizePx.micro, color: 'var(--terminal-text-dim)' }}>
            {statusLabel(p.status)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function AgentPaneList(props: AgentPaneListProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? <AgentPaneListV2 {...props} /> : <AgentPaneListClassic {...props} />;
}
