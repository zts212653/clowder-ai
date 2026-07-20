/**
 * F252 Story Player — Replay Event Bubble
 *
 * Renders a single ReplayEvent as a chat bubble, tool call card, or system message.
 * Supports cinematic (animated text reveal) and faithful (instant) display modes.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import type { ReplayEvent } from '@/lib/story-player/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplayEventBubbleProps {
  event: ReplayEvent;
  displayMode: 'cinematic' | 'faithful';
  /** Whether this is the currently-revealing event (last in visible list) */
  isRevealing: boolean;
  /** Speed multiplier for cinematic animation */
  speedMultiplier: number;
}

// ---------------------------------------------------------------------------
// Text Animator (cinematic mode)
// ---------------------------------------------------------------------------

function useCinematicText(content: string, isActive: boolean, speedMultiplier: number): string {
  const [visibleChars, setVisibleChars] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isActive) {
      setVisibleChars(content.length);
      return;
    }

    setVisibleChars(0);
    // Characters per second scales with speed: base 60 cps * speed
    const cps = Math.min(60 * speedMultiplier, 100_000);
    const intervalMs = Math.max(1, 1000 / cps);
    const charsPerTick = Math.max(1, Math.ceil(cps / (1000 / intervalMs)));

    intervalRef.current = setInterval(() => {
      setVisibleChars((prev) => {
        const next = prev + charsPerTick;
        if (next >= content.length) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return content.length;
        }
        return next;
      });
    }, intervalMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [content, isActive, speedMultiplier]);

  return content.slice(0, visibleChars);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolCallCard({ event }: { event: ReplayEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isPassBall = event.isPassBall === true;

  return (
    <div
      style={{
        background: 'var(--color-surface-secondary, #1e1e30)',
        border: '1px solid var(--color-border, #333)',
        borderRadius: '6px',
        padding: '8px 12px',
        margin: '4px 0',
        fontSize: 'var(--console-font-compact)',
        fontFamily: 'var(--font-mono, monospace)',
        // AC-B1: Highlight pass-ball tool calls (cross_post, multi_mention)
        ...(isPassBall
          ? {
              borderLeft: '3px solid var(--color-warning, #f59e0b)',
              boxShadow: '0 0 8px rgba(245, 158, 11, 0.2)',
            }
          : {}),
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'inherit',
          font: 'inherit',
          width: '100%',
          textAlign: 'left',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ opacity: 0.6 }}>🔧</span>
        <span style={{ fontWeight: 600, color: 'var(--color-accent, #6366f1)' }}>
          {event.toolName ?? 'Unknown Tool'}
        </span>
        {event.toolIsError && (
          <span style={{ color: 'var(--color-error, #ef4444)', fontSize: 'var(--console-font-label)' }}>ERROR</span>
        )}
        <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 'var(--console-font-label)' }}>
          {expanded ? '▼' : '▶'}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: '8px', fontSize: 'var(--console-font-xs)' }}>
          {event.toolInput && (
            <div style={{ marginBottom: '6px' }}>
              <div style={{ opacity: 0.5, marginBottom: '2px' }}>Input:</div>
              <pre
                style={{
                  margin: 0,
                  padding: '6px',
                  background: 'var(--color-surface, #0d0d1a)',
                  borderRadius: '4px',
                  overflow: 'auto',
                  maxHeight: '200px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {formatToolContent(event.toolInput)}
              </pre>
            </div>
          )}
          {event.toolResult && (
            <div>
              <div style={{ opacity: 0.5, marginBottom: '2px' }}>Result{event.toolIsError ? ' (error)' : ''}:</div>
              <pre
                style={{
                  margin: 0,
                  padding: '6px',
                  background: event.toolIsError ? 'rgba(239, 68, 68, 0.1)' : 'var(--color-surface, #0d0d1a)',
                  borderRadius: '4px',
                  overflow: 'auto',
                  maxHeight: '300px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {event.toolResult.length > 2000
                  ? `${event.toolResult.slice(0, 2000)}...\n[${event.toolResult.length - 2000} chars truncated]`
                  : event.toolResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatToolContent(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ReplayEventBubble({ event, displayMode, isRevealing, speedMultiplier }: ReplayEventBubbleProps) {
  const resolveCatName = useCatNameResolver();
  const isCinematic = displayMode === 'cinematic' && isRevealing;
  const displayText = useCinematicText(
    event.content,
    isCinematic,
    typeof speedMultiplier === 'number' ? speedMultiplier : 100,
  );

  // System events (session_init, done, etc.)
  if (event.type === 'system') {
    return (
      <div
        style={{
          textAlign: 'center',
          fontSize: 'var(--console-font-label)',
          opacity: 0.5,
          padding: '4px 0',
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        ── {event.content || event.type} ──
      </div>
    );
  }

  // Tool calls
  if (event.type === 'tool_call') {
    return <ToolCallCard event={event} />;
  }

  // Thinking
  if (event.type === 'thinking') {
    return (
      <div
        style={{
          background: 'rgba(99, 102, 241, 0.08)',
          borderLeft: '3px solid var(--color-accent, #6366f1)',
          borderRadius: '0 6px 6px 0',
          padding: '8px 12px',
          margin: '4px 0',
          fontSize: 'var(--console-font-compact)',
          opacity: 0.7,
          fontStyle: 'italic',
          whiteSpace: 'pre-wrap',
        }}
      >
        <span style={{ fontSize: 'var(--console-font-label)', opacity: 0.6 }}>💭 Thinking</span>
        <div style={{ marginTop: '4px' }}>{displayText}</div>
      </div>
    );
  }

  // Messages (user / assistant)
  const isUser = event.role === 'user';
  const isPassBall = event.isPassBall === true;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        margin: '6px 0',
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
          background: isUser ? 'var(--color-accent, #6366f1)' : 'var(--color-surface-secondary, #1e1e30)',
          color: isUser ? '#fff' : 'var(--color-text-primary, #e0e0e0)',
          fontSize: 'var(--console-font-sm)',
          lineHeight: '1.5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          // AC-B1: Highlight pass-ball events with accent border
          ...(isPassBall
            ? {
                borderLeft: '3px solid var(--color-warning, #f59e0b)',
                boxShadow: '0 0 8px rgba(245, 158, 11, 0.2)',
              }
            : {}),
        }}
      >
        {!isUser && event.catId && (
          <div
            style={{
              fontSize: 'var(--console-font-label)',
              opacity: 0.6,
              marginBottom: '4px',
              fontFamily: 'var(--font-mono, monospace)',
            }}
          >
            {resolveCatName(event.catId)}
          </div>
        )}
        {displayText}
      </div>
    </div>
  );
}
