'use client';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import typographyTokens from '@/styles/typography-tokens.json';
import { API_URL } from '@/utils/api-client';
import { TERMINAL_THEME } from './terminal-theme';

interface AgentPaneViewerProps {
  worktreeId: string;
  paneId: string;
  onBack: () => void;
}

export function AgentPaneViewer({ worktreeId, paneId, onBack }: AgentPaneViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'watching' | 'disconnected'>('connecting');

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      fontSize: typographyTokens.fontSizePx.compact,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      disableStdin: true,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const apiUrl = new URL(API_URL);
    const ws = new WebSocket(
      `${wsProtocol}//${apiUrl.host}/api/terminal/agent-panes/${paneId}/ws?worktreeId=${encodeURIComponent(worktreeId)}`,
    );

    ws.onopen = () => {
      setStatus('watching');
      const dims = fitAddon.proposeDimensions();
      if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    };
    ws.onmessage = (event) => {
      term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = () => setStatus('disconnected');

    const container = containerRef.current;
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [worktreeId, paneId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          fontSize: typographyTokens.fontSizePx.xs,
          color: 'var(--terminal-text-muted)',
          borderBottom: '1px solid var(--terminal-chrome)',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'none',
            border: '1px solid var(--terminal-btn-border)',
            color: 'var(--terminal-text)',
            padding: '2px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: typographyTokens.fontSizePx.label,
          }}
        >
          Back to shell
        </button>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background:
              status === 'watching'
                ? 'var(--terminal-status-info)'
                : status === 'connecting'
                  ? 'var(--terminal-status-warn)'
                  : 'var(--terminal-status-error)',
          }}
        />
        <span>
          {status === 'watching' ? `Watching ${paneId}` : status === 'connecting' ? 'Connecting\u2026' : 'Disconnected'}
        </span>
        <span
          style={{
            fontSize: typographyTokens.fontSizePx.micro,
            color: 'var(--terminal-text-faint)',
            marginLeft: 'auto',
          }}
        >
          read-only
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} />
    </div>
  );
}
