'use client';

import { useState } from 'react';
import type { TimeoutDiagnostics } from '@/stores/chat-types';

/** Lucide circle-x icon (inline SVG) */
function CircleXIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

/** Lucide chevron-down icon */
function ChevronDownIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatSilenceDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${ms}ms (${min}m ${sec}s)`;
}

/** @deprecated — CSS truncation preferred; kept only if needed by non-flex contexts */

interface TimeoutDiagnosticsPanelProps {
  errorMessage: string;
  diagnostics: TimeoutDiagnostics;
  description?: string;
}

/**
 * F118 AC-C3: Enhanced timeout diagnostics panel.
 * Renders error banner + collapsible diagnostics per Pencil Scene 4.
 */
export function TimeoutDiagnosticsPanel({ errorMessage, diagnostics, description }: TimeoutDiagnosticsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const rows: { key: string; value: string; purple?: boolean }[] = [
    { key: 'silenceDuration', value: formatSilenceDuration(diagnostics.silenceDurationMs) },
    { key: 'processAlive', value: diagnostics.processAlive ? 'true (at timeout)' : 'false' },
  ];
  if (diagnostics.lastEventType) {
    rows.push({ key: 'lastEventType', value: diagnostics.lastEventType });
  }
  if (diagnostics.firstEventAt) {
    rows.push({ key: 'firstEventAt', value: formatTime(diagnostics.firstEventAt) });
  }
  if (diagnostics.lastEventAt) {
    rows.push({ key: 'lastEventAt', value: formatTime(diagnostics.lastEventAt) });
  }
  if (diagnostics.cliSessionId) {
    rows.push({ key: 'cliSessionId', value: diagnostics.cliSessionId, purple: true });
  }
  if (diagnostics.invocationId) {
    rows.push({ key: 'invocationId', value: diagnostics.invocationId, purple: true });
  }
  if (diagnostics.rawArchivePath) {
    rows.push({ key: 'rawArchivePath', value: diagnostics.rawArchivePath, purple: true });
  }

  return (
    <div data-testid="timeout-diagnostics" className="flex flex-col gap-2.5">
      {/* Error banner */}
      <div
        className="flex items-center gap-2.5 rounded-[10px]"
        style={{
          backgroundColor: 'var(--conn-red-bg)',
          border: '1px solid var(--console-diag-border)',
          padding: '10px 14px',
        }}
      >
        <CircleXIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--conn-amber-text)' }} />
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold" style={{ color: 'var(--cafe-text)' }}>
            {errorMessage}
          </span>
          {description && (
            <span className="text-xs" style={{ color: 'var(--cafe-text-secondary)', lineHeight: 1.4 }}>
              {description}
            </span>
          )}
        </div>
      </div>

      {/* Diagnostics toggle */}
      <button
        data-testid="diagnostics-toggle"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 cursor-pointer bg-transparent border-none p-0"
      >
        <ChevronDownIcon
          className="w-3.5 h-3.5 transition-transform"
          style={{ color: 'var(--cafe-text-muted)', transform: expanded ? 'rotate(180deg)' : undefined }}
        />
        <span className="text-xs font-semibold" style={{ color: 'var(--cafe-text-muted)' }}>
          Diagnostics
        </span>
      </button>

      {/* Expanded diagnostics panel */}
      {expanded && (
        <div
          data-testid="diagnostics-panel"
          className="rounded-lg"
          style={{ backgroundColor: 'var(--cafe-text)', padding: '12px 14px' }}
        >
          <div className="flex flex-col gap-1">
            {rows.map((row) => (
              <div key={row.key} className="flex gap-2 min-w-0">
                <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--cafe-text-muted)' }}>
                  {row.key}
                </span>
                <span
                  className="truncate min-w-0 text-xs"
                  style={{ color: row.purple ? 'var(--console-diag-key)' : 'var(--console-diag-val)' }}
                  title={row.value}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
