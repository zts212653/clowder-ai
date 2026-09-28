'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import typographyTokens from '@/styles/typography-tokens.json';
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
  const [snapshot, setSnapshot] = useState<{ worktreeId: string; panes: AgentPane[] }>({ worktreeId, panes: [] });
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const requestEpoch = useRef(0);
  const currentVisibility = useRef(surfaceVisible);
  const currentWorktreeId = useRef(worktreeId);

  useLayoutEffect(() => {
    if (currentVisibility.current === surfaceVisible) return;
    currentVisibility.current = surfaceVisible;
    ++requestEpoch.current;
  }, [surfaceVisible]);

  useLayoutEffect(() => {
    if (currentWorktreeId.current === worktreeId) return;
    currentWorktreeId.current = worktreeId;
    ++requestEpoch.current;
  }, [worktreeId]);

  const refresh = useCallback(async () => {
    const request = ++requestEpoch.current;
    try {
      const res = await apiFetch(`/api/terminal/agent-panes?worktreeId=${encodeURIComponent(worktreeId)}`);
      if (!res.ok) return;
      const nextPanes = (await res.json()) as AgentPane[];
      const ownsCurrentRead =
        request === requestEpoch.current && currentVisibility.current && currentWorktreeId.current === worktreeId;
      if (ownsCurrentRead) setSnapshot({ worktreeId, panes: nextPanes });
    } catch {
      /* ignore fetch errors */
    }
  }, [worktreeId]);

  useEffect(() => {
    if (!surfaceVisible) return;
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      clearInterval(interval);
      ++requestEpoch.current;
    };
  }, [refresh, surfaceVisible]);

  const panes = snapshot.worktreeId === worktreeId ? snapshot.panes : [];

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
