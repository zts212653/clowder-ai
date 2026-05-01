'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { CliEvent, CliStatus } from '@/stores/chat-types';

/* ── Helpers ── */

/** Convert hex to rgba */
function hexToRgba(hex: string, opacity: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Blend accent into a dark base → tinted dark surface (not transparent) */
function tintedDark(hex: string, ratio = 0.25, base = '#1A1625'): string {
  const parse = (h: string) => [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(base);
  return `rgb(${Math.round(r2 + (r1 - r2) * ratio)}, ${Math.round(g2 + (g1 - g2) * ratio)}, ${Math.round(b2 + (b1 - b2) * ratio)})`;
}

/** Lighten a hex color toward white by ratio (0-1) */
function lighten(hex: string, ratio: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * ratio);
  const lg = Math.round(g + (255 - g) * ratio);
  const lb = Math.round(b + (255 - b) * ratio);
  return `rgb(${lr}, ${lg}, ${lb})`;
}

/* ── Divider stays neutral; surface colors are now breed-tinted (see buildSurface) ── */
const DIVIDER = '#334155';

/* ── Inline SVG icons (Lucide-style, from Pencil design) ── */

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="transition-transform duration-150 flex-shrink-0"
      style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function WrenchIcon({ color }: { color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || '#E2E8F0'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#22D3EE"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LoaderIcon({ color }: { color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function PawPrint() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#64748B"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </svg>
  );
}

/* ── Status helpers ── */

const STATUS_LABEL: Record<CliStatus, string> = {
  streaming: 'streaming',
  done: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
};

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function buildSummary(events: CliEvent[], status: CliStatus): string {
  const toolCount = events.filter((e) => e.kind === 'tool_use').length;
  const statusLabel = STATUS_LABEL[status];
  const timestamps = events.map((e) => e.timestamp).filter(Boolean);
  const duration =
    timestamps.length >= 2 && status !== 'streaming'
      ? ` · ${formatDuration(Math.max(...timestamps) - Math.min(...timestamps))}`
      : '';
  if (status === 'streaming') {
    const last = [...events].reverse().find((e) => e.kind === 'tool_use');
    return `CLI Output · ${statusLabel}${last ? ` · ${last.label}...` : ''}`;
  }
  if (toolCount > 0) {
    return `CLI Output · ${statusLabel} · ${toolCount} tool${toolCount > 1 ? 's' : ''}${duration}`;
  }
  const lineCount = events
    .filter((e) => e.kind === 'text')
    .reduce((n, e) => n + (e.content?.split('\n').length ?? 0), 0);
  return `CLI Output · ${statusLabel} · ${lineCount} line${lineCount !== 1 ? 's' : ''}${duration}`;
}

/* ── Tool row — design: [status] [wrench] [name] [detail] [result] ── */

function ToolRow({
  event,
  isActive,
  onUserInteract,
  accent,
}: {
  event: CliEvent;
  isActive: boolean;
  onUserInteract?: () => void;
  accent: string;
}) {
  const [rowExpanded, setRowExpanded] = useState(false);
  const hasResult = event.detail != null;
  // Design: active = breed bg 20% + left border 2px + lighter text
  const accentLight = lighten(accent, 0.6); // ~#C084FC equivalent
  const accentVeryLight = lighten(accent, 0.9); // ~#F5F3FF equivalent

  return (
    <button
      type="button"
      data-testid={`tool-row-${event.id}`}
      className="w-full text-left cursor-pointer rounded font-mono text-[11px] flex items-center gap-2"
      style={{
        padding: '5px 8px',
        borderRadius: 4,
        backgroundColor: isActive ? hexToRgba(accent, 0.2) : undefined,
        borderLeft: isActive ? `2px solid ${accent}` : undefined,
      }}
      onClick={() => {
        setRowExpanded((v) => !v);
        onUserInteract?.();
      }}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Status icon */}
        {isActive ? <LoaderIcon color={accentLight} /> : hasResult ? <CheckIcon /> : null}
        {/* Wrench icon — design: #E2E8F0 normal, #F5F3FF active */}
        <WrenchIcon color={isActive ? accentVeryLight : '#E2E8F0'} />
        {/* Tool label (full) */}
        <span className="truncate" style={{ color: isActive ? accentVeryLight : '#E2E8F0' }}>
          <span className="font-medium">{event.label?.split(' ')[0]}</span>
          {event.label?.includes(' ') && (
            <span
              style={{ color: isActive ? accentLight : '#64748B' }}
            >{` ${event.label.split(' ').slice(1).join(' ')}`}</span>
          )}
        </span>
      </div>
      {/* Detail — hidden by default, shown on click */}
      {hasResult && !rowExpanded && <ChevronIcon expanded={false} />}
      {rowExpanded && hasResult && event.detail && (
        <div className="w-full mt-1 pl-7 whitespace-pre-wrap text-[10px]" style={{ color: '#64748B' }}>
          {event.detail}
        </div>
      )}
    </button>
  );
}

/* ── Collapsible tools section ── */

function ToolsSection({
  toolUses,
  toolResults,
  lastToolId,
  status,
  onUserInteract,
  accent,
}: {
  toolUses: CliEvent[];
  toolResults: CliEvent[];
  lastToolId: string | undefined;
  status: CliStatus;
  onUserInteract: () => void;
  accent: string;
}) {
  const isStreaming = status === 'streaming';
  const [toolsExpanded, setToolsExpanded] = useState(isStreaming);
  const toolsUserInteracted = useRef(false);

  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current !== 'streaming' && isStreaming) {
      toolsUserInteracted.current = false;
      setToolsExpanded(true);
    } else if (prevStatus.current === 'streaming' && !isStreaming && !toolsUserInteracted.current) {
      setToolsExpanded(false);
    }
    prevStatus.current = status;
  }, [status, isStreaming]);

  if (isStreaming && !toolsExpanded && !toolsUserInteracted.current) {
    setToolsExpanded(true);
  }

  const toolSummary = `${toolUses.length} tool${toolUses.length > 1 ? 's' : ''}`;

  return (
    <div style={{ padding: '4px 12px' }}>
      <button
        type="button"
        data-testid="tools-section-toggle"
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-mono rounded transition-colors"
        style={{ color: '#94A3B8' }}
        onClick={() => {
          toolsUserInteracted.current = true;
          setToolsExpanded((v) => !v);
          onUserInteract();
        }}
      >
        <ChevronIcon expanded={toolsExpanded} />
        <span>{toolsExpanded ? toolSummary : `${toolSummary} (collapsed)`}</span>
      </button>
      {toolsExpanded && (
        <div className="space-y-0.5">
          {toolUses.map((e, i) => {
            const result = toolResults[i];
            return (
              <ToolRow
                key={e.id}
                event={{ ...e, detail: result?.detail ?? e.detail }}
                isActive={e.id === lastToolId}
                onUserInteract={onUserInteract}
                accent={accent}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Main component ── */

interface CliOutputBlockProps {
  events: CliEvent[];
  status: CliStatus;
  thinkingMode?: 'debug' | 'play';
  defaultExpanded?: boolean;
  breedColor?: string;
}

export function CliOutputBlock({
  events,
  status,
  thinkingMode,
  defaultExpanded = false,
  breedColor,
}: CliOutputBlockProps) {
  const isExport =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
  const forceExpanded = status === 'streaming' || isExport;
  const [expanded, setExpanded] = useState(forceExpanded || defaultExpanded);
  const userInteracted = useRef(false);
  const hasMounted = useRef(false);

  if (forceExpanded && !expanded && !userInteracted.current) {
    setExpanded(true);
  }

  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current !== 'streaming' && status === 'streaming') {
      userInteracted.current = false;
      setExpanded(true);
    } else if (prevStatusRef.current === 'streaming' && status !== 'streaming' && !userInteracted.current) {
      setExpanded(defaultExpanded);
    }
    prevStatusRef.current = status;
  }, [status, defaultExpanded]);

  // Sync expanded state when defaultExpanded prop changes (e.g. async config load)
  useEffect(() => {
    if (!userInteracted.current) {
      setExpanded(forceExpanded || defaultExpanded);
    }
  }, [defaultExpanded, forceExpanded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: expanded is intentional — dispatch on toggle
  useLayoutEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
    }
  }, [expanded]);

  if (events.length === 0) return null;

  const summary = buildSummary(events, status);
  const toolUses = events.filter((e) => e.kind === 'tool_use');
  const toolResults = events.filter((e) => e.kind === 'tool_result');
  const textEvents = events.filter((e) => e.kind === 'text');
  const lastToolId = status === 'streaming' ? [...events].reverse().find((e) => e.kind === 'tool_use')?.id : undefined;
  const accent = breedColor || '#7C3AED';
  // Breed-tinted dark surface: accent blended into dark base → visibly colored AND text-readable
  const surface = tintedDark(accent, 0.25);
  const surfaceInner = tintedDark(accent, 0.18);

  const handleToggle = () => {
    userInteracted.current = true;
    setExpanded((v) => !v);
  };

  return (
    <div className="mt-2 mb-1 overflow-hidden" style={{ backgroundColor: surface, borderRadius: 10 }}>
      {/* Header — design: chevron(accent) + summary(slate-400) + paw chip */}
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-2 text-[11px] font-mono transition-colors"
        style={{ padding: '8px 12px', color: '#94A3B8', backgroundColor: surface }}
      >
        <span style={{ color: accent }}>
          <ChevronIcon expanded={expanded} />
        </span>
        <span className="font-medium">{summary}</span>
        <span className="ml-auto flex items-center gap-1" style={{ color: '#64748B', fontSize: 10 }}>
          {thinkingMode === 'debug' ? (
            <>
              <PawPrint />
              <span>shared</span>
            </>
          ) : (
            <span>private</span>
          )}
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div data-testid="cli-output-body" style={{ backgroundColor: surfaceInner }}>
          <div style={{ height: 1, backgroundColor: DIVIDER }} />
          {toolUses.length > 0 && (
            <ToolsSection
              toolUses={toolUses}
              toolResults={toolResults}
              lastToolId={lastToolId}
              status={status}
              onUserInteract={() => {
                userInteracted.current = true;
              }}
              accent={accent}
            />
          )}
          {textEvents.length > 0 && (
            <>
              {toolUses.length > 0 && (
                <>
                  <div style={{ height: 1, backgroundColor: DIVIDER }} />
                  <div
                    style={{
                      padding: '8px 12px 4px 12px',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 10,
                      color: '#475569',
                    }}
                  >
                    ─── stdout ───
                  </div>
                </>
              )}
              <div
                style={{ padding: '8px 12px 10px 12px' }}
                className="font-mono text-[11px] leading-relaxed cli-output-md"
              >
                <span style={{ color: '#CBD5E1' }}>
                  <MarkdownContent content={textEvents.map((e) => e.content).join('\n')} />
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
