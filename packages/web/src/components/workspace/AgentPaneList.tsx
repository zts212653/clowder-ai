'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface AgentPane {
  invocationId: string;
  paneId: string;
  status: 'running' | 'done' | 'crashed';
  startedAt: number;
}

interface AgentPaneListProps {
  worktreeId: string;
  onSelectPane: (paneId: string) => void;
  selectedPaneId?: string;
}

export function AgentPaneList({ worktreeId, onSelectPane, selectedPaneId }: AgentPaneListProps) {
  const [panes, setPanes] = useState<AgentPane[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/terminal/agent-panes?worktreeId=${encodeURIComponent(worktreeId)}`);
      if (res.ok) setPanes((await res.json()) as AgentPane[]);
    } catch {
      /* ignore fetch errors */
    }
  }, [worktreeId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (panes.length === 0) return null;

  const statusColor = (s: AgentPane['status']) =>
    s === 'running'
      ? 'var(--terminal-text-success)'
      : s === 'crashed'
        ? 'var(--terminal-text-error)'
        : 'var(--terminal-text-muted)';
  const statusLabel = (s: AgentPane['status']) => (s === 'running' ? 'Running' : s === 'crashed' ? 'Crashed' : 'Done');

  return (
    <div style={{ borderBottom: '1px solid var(--terminal-selected-bg)', padding: '4px 0' }}>
      <div style={{ padding: '2px 8px', fontSize: 11, color: 'var(--terminal-text-dim)', fontWeight: 600 }}>
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
            fontSize: 12,
            background: selectedPaneId === p.paneId ? 'var(--terminal-selected-bg)' : 'transparent',
            border: 'none',
            color: 'var(--terminal-text)',
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
          <span style={{ fontSize: 10, color: 'var(--terminal-text-dim)' }}>{statusLabel(p.status)}</span>
        </button>
      ))}
    </div>
  );
}
