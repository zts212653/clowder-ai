'use client';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, apiFetch } from '@/utils/api-client';

import { AgentPaneList } from './AgentPaneList';
import { AgentPaneViewer } from './AgentPaneViewer';
import '@xterm/xterm/css/xterm.css';

interface TerminalTabProps {
  worktreeId: string;
}

export function TerminalTab({ worktreeId }: TerminalTabProps) {
  const [watchingPane, setWatchingPane] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');

  const connect = useCallback(async () => {
    if (!containerRef.current) return;
    setStatus('connecting');
    try {
      // POST will auto-reconnect to an existing disconnected session
      const res = await apiFetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, cols: 80, rows: 24 }),
      });
      if (!res.ok) {
        setStatus('disconnected');
        return;
      }
      const { sessionId } = (await res.json()) as {
        sessionId: string;
        paneId: string;
        reconnected: boolean;
      };
      sessionIdRef.current = sessionId;

      // Init xterm.js
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
        theme: {
          background: '#1a1b26',
          foreground: '#a9b1d6',
          cursor: '#c0caf5',
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();
      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      // Connect WebSocket
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const apiUrl = new URL(API_URL);
      const ws = new WebSocket(`${wsProtocol}//${apiUrl.host}/api/terminal/sessions/${sessionId}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      };

      ws.onmessage = (event) => {
        term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
      };

      ws.onclose = () => {
        setStatus('disconnected');
      };

      // Terminal input → WebSocket
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Resize handling
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      });
      resizeObserver.observe(containerRef.current);

      const cleanup = () => {
        resizeObserver.disconnect();
        ws.close();
        term.dispose();
      };
      cleanupRef.current = cleanup;
      return cleanup;
    } catch {
      setStatus('disconnected');
    }
  }, [worktreeId]);

  const closeSession = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    terminalRef.current = null;
    wsRef.current = null;
    if (sessionIdRef.current) {
      apiFetch(`/api/terminal/sessions/${sessionIdRef.current}`, { method: 'DELETE' }).catch(() => {});
      sessionIdRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    connect().then((fn) => {
      cleanup = fn;
    });
    return () => {
      cleanup?.(); // Disconnect WS only — don't DELETE session
    };
  }, [connect]);

  if (watchingPane) {
    return <AgentPaneViewer worktreeId={worktreeId} paneId={watchingPane} onBack={() => setWatchingPane(null)} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AgentPaneList
        worktreeId={worktreeId}
        onSelectPane={setWatchingPane}
        selectedPaneId={watchingPane ?? undefined}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          fontSize: 12,
          color: '#888',
          borderBottom: '1px solid #2a2b3d',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: status === 'connected' ? '#9ece6a' : status === 'connecting' ? '#e0af68' : '#f7768e',
          }}
        />
        <span>
          {status === 'connected' ? 'Terminal' : status === 'connecting' ? 'Connecting\u2026' : 'Disconnected'}
        </span>
        {status === 'disconnected' && (
          <button
            onClick={() => void connect()}
            type="button"
            style={{
              background: 'none',
              border: '1px solid #444',
              color: '#aaa',
              padding: '2px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            Reconnect
          </button>
        )}
        {(status === 'connected' || status === 'disconnected') && (
          <button
            onClick={closeSession}
            type="button"
            style={{
              background: 'none',
              border: '1px solid #6b3030',
              color: '#f7768e',
              padding: '2px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              marginLeft: 'auto',
            }}
          >
            Close Terminal
          </button>
        )}
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} />
    </div>
  );
}
