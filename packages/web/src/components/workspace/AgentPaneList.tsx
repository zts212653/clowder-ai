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

  const statusColor = (s: AgentPane['status']) => (s === 'running' ? '#9ece6a' : s === 'crashed' ? '#f7768e' : '#888');
  const statusLabel = (s: AgentPane['status']) => (s === 'running' ? 'Running' : s === 'crashed' ? 'Crashed' : 'Done');

  return (
    <div style={{ borderBottom: '1px solid #2a2b3d', padding: '4px 0' }}>
      <div style={{ padding: '2px 8px', fontSize: 11, color: '#666', fontWeight: 600 }}>Agent Panes</div>
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
            background: selectedPaneId === p.paneId ? '#2a2b3d' : 'transparent',
            border: 'none',
            color: '#a9b1d6',
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
          <span style={{ fontSize: 10, color: '#666' }}>{statusLabel(p.status)}</span>
        </button>
      ))}
    </div>
  );
}
