'use client';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import typographyTokens from '@/styles/typography-tokens.json';
import { API_URL } from '@/utils/api-client';
import { type CodeToolsCopy, codeToolsCopy } from './code-tools.shell-copy';
import { TERMINAL_THEME } from './terminal-theme';

interface AgentPaneViewerProps {
  worktreeId: string;
  paneId: string;
  onBack: () => void;
  /** F322 v2: resolved cat identity for the pane owner; absent = fall back to the pane id. */
  catId?: string | null;
}

type PaneViewerCopy = Pick<
  CodeToolsCopy['terminal'],
  'backToMyTerminal' | 'connecting' | 'disconnected' | 'readOnly' | 'watching'
>;

const CLASSIC_COPY: PaneViewerCopy = {
  backToMyTerminal: 'Back to shell',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  readOnly: 'read-only',
  watching: (label: string) => `Watching ${label}`,
};

export function AgentPaneViewer(props: AgentPaneViewerProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? (
    <AgentPaneViewerV2 {...props} />
  ) : (
    <AgentPaneViewerCore {...props} copy={CLASSIC_COPY} subjectLabel={props.paneId} />
  );
}

function AgentPaneViewerV2(props: AgentPaneViewerProps) {
  const copy = useShellCopy(codeToolsCopy).terminal;
  const { getCatById } = useCatData();
  const subjectLabel = props.catId ? resolveCatDisplayName(props.catId, getCatById) : props.paneId;
  return <AgentPaneViewerCore {...props} copy={copy} subjectLabel={subjectLabel} />;
}

function AgentPaneViewerCore({
  worktreeId,
  paneId,
  onBack,
  copy,
  subjectLabel,
}: AgentPaneViewerProps & { copy: PaneViewerCopy; subjectLabel: string }) {
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
          {copy.backToMyTerminal}
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
          {status === 'watching'
            ? copy.watching(subjectLabel)
            : status === 'connecting'
              ? copy.connecting
              : copy.disconnected}
        </span>
        <span
          style={{
            fontSize: typographyTokens.fontSizePx.micro,
            color: 'var(--terminal-text-faint)',
            marginLeft: 'auto',
          }}
        >
          {copy.readOnly}
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} />
    </div>
  );
}
