'use client';

/**
 * F252 Phase E — Replay Message List
 *
 * Renders bridged replay events using Hub-native components.
 * operator iron rule: "100% 看起来就是你们平时的样子" — we reuse
 * MessageBubble, ThinkingContent, CliOutputBlock, CatAvatar,
 * and CollapsibleMarkdown directly.
 */

import { type CSSProperties, memo, useEffect, useRef } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { CollapsibleMarkdown } from '@/components/CollapsibleMarkdown';
import { CliOutputBlock } from '@/components/cli-output/CliOutputBlock';
import { MessageBubble } from '@/components/MessageBubble';
import { ThinkingContent } from '@/components/ThinkingContent';
import { useCatData } from '@/hooks/useCatData';
import { hexToOklch } from '@/lib/color-utils';
import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import type { CliEvent, CliStatus } from '@/stores/chat-types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReplayMessageListProps {
  /** Visible messages (up to currentIndex from engine) */
  messages: ReplayChatMessage[];
  /** Auto-scroll to bottom on new messages */
  autoScroll?: boolean;
  /** Empty-state copy for contexts where playback has no replayable events */
  emptyStateLabel?: string;
  /**
   * Display mode from replay engine.
   * - 'cinematic' (default): hide thinking blocks for immersive viewing
   * - 'faithful': show full thinking content alongside text
   */
  displayMode?: 'cinematic' | 'faithful';
}

// ---------------------------------------------------------------------------
// Helpers — bridge ReplayChatMessage fields to Hub component props
// ---------------------------------------------------------------------------

/** Map replay tool/stdout fields to CliEvent[] for CliOutputBlock */
function toCliEvents(toolEvents: ReplayChatMessage['toolEvents'], cliStdout?: string): CliEvent[] {
  const result: CliEvent[] = [];
  for (const te of toolEvents ?? []) {
    const baseTimestamp = Date.now(); // display-only, not used for replay ordering
    result.push({
      id: `${te.id}_use`,
      kind: 'tool_use',
      timestamp: baseTimestamp,
      label: te.name,
      detail: te.input,
    });
    if (te.output != null) {
      result.push({
        id: `${te.id}_result`,
        kind: 'tool_result',
        timestamp: baseTimestamp + 1,
        detail: te.output,
      });
    }
  }
  if (cliStdout?.trim()) {
    result.push({
      id: 'stdout-text',
      kind: 'text',
      timestamp: result.length > 0 ? result[result.length - 1].timestamp + 1 : Date.now(),
      content: cliStdout,
    });
  }
  return result;
}

/** Derive CliStatus from tool events */
function toCliStatus(toolEvents: ReplayChatMessage['toolEvents']): CliStatus {
  if (toolEvents?.some((te) => te.status === 'error')) return 'failed';
  return 'done';
}

/** System message avatar — generic icon, no cat */
function SystemAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-[var(--console-surface-1,#222)] flex items-center justify-center flex-shrink-0">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-[var(--console-text-tertiary,#666)]"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    </div>
  );
}

/** User avatar — simple person icon */
function UserAvatar() {
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: 'var(--color-cocreator-primary)', color: 'var(--cafe-surface)' }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper — per-cat persona style for wrapperStyle (F056 token chain)
// ---------------------------------------------------------------------------

/** Compute --msg-hue/--msg-chroma from a cat's primary color. */
function catPersonaStyle(primary: string | undefined): CSSProperties {
  let msgHue = 297; // fallback hue (purple)
  let msgChroma = 0.1;
  if (primary) {
    try {
      const oklch = hexToOklch(primary);
      if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
        msgHue = oklch.h;
        msgChroma = oklch.c;
      }
    } catch {
      /* keep fallback values */
    }
  }
  return { '--msg-hue': msgHue, '--msg-chroma': msgChroma } as CSSProperties;
}

const ASSISTANT_BUBBLE_STYLE = {
  backgroundColor: 'var(--cat-msg-surface)',
  color: 'var(--cat-msg-text)',
} as const satisfies CSSProperties;

const USER_BUBBLE_STYLE = {
  backgroundColor: 'var(--color-cocreator-surface)',
  color: 'var(--cat-msg-text)',
} as const satisfies CSSProperties;

const USER_PERSONA_STYLE = {
  '--msg-hue': 40,
  '--msg-chroma': 0.13,
} as CSSProperties;

function messageScrollSignature(msg: ReplayChatMessage): string {
  let toolPayloadLength = 0;
  if (msg.toolEvents) {
    for (const tool of msg.toolEvents) {
      toolPayloadLength += (tool.input?.length ?? 0) + (tool.output?.length ?? 0);
    }
  }
  return [
    msg.id,
    msg.content.length,
    msg.thinking?.length ?? 0,
    msg.cliStdout?.length ?? 0,
    msg.toolEvents?.length ?? 0,
    toolPayloadLength,
  ].join(':');
}

function buildScrollSignature(messages: ReplayChatMessage[]): string {
  return messages.map(messageScrollSignature).join('|');
}

// ---------------------------------------------------------------------------
// Single message renderer
// ---------------------------------------------------------------------------

const ReplayMessage = memo(function ReplayMessage({
  msg,
  displayMode = 'cinematic',
}: {
  msg: ReplayChatMessage;
  displayMode?: 'cinematic' | 'faithful';
}) {
  const { getCatById } = useCatData();
  // cinematic: hide thinking blocks for immersive replay (mirrors ReplayEventBubble behavior)
  // faithful: show full thinking content (complete transcript view)
  const showThinking = displayMode === 'faithful';

  // ── System messages ──
  if (msg.type === 'system') {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-[var(--console-text-tertiary,#888)] bg-[var(--console-surface-1,#1a1a2e)] px-3 py-1 rounded-full">
          {msg.content || '── system ──'}
        </span>
      </div>
    );
  }

  // ── User messages ──
  if (msg.type === 'user') {
    return (
      <MessageBubble
        messageId={msg.id}
        avatar={<UserAvatar />}
        align="right"
        wrapperClassName="cat-persona-derived"
        wrapperStyle={USER_PERSONA_STYLE}
        bubbleStyle={USER_BUBBLE_STYLE}
      >
        <CollapsibleMarkdown content={msg.content} />
      </MessageBubble>
    );
  }

  // ── Assistant messages (text / tool calls / thinking) ──
  const avatar = msg.catId ? <CatAvatar catId={msg.catId} size={32} /> : <SystemAvatar />;

  // F056: Derive per-cat --msg-hue/--msg-chroma from catId so .cat-persona-derived
  // resolves the correct bubble/surface/inset tokens (matching Hub's ChatMessage behavior).
  const catData = msg.catId ? getCatById(msg.catId) : undefined;
  const personaStyle = catPersonaStyle(catData?.color?.primary);

  // cat-persona-derived + personaStyle provides --cat-msg-{surface,inset,...} CSS vars
  // for ThinkingContent/CliOutputBlock, and per-cat bubble color for the message wrapper.
  const personaWrapper = 'cat-persona-derived';

  // Thinking-only message — hidden in cinematic mode (same as ReplayEventBubble)
  if (msg.thinking && !msg.content && !msg.cliStdout && !msg.toolEvents?.length) {
    if (!showThinking) return null;
    return (
      <MessageBubble
        messageId={msg.id}
        avatar={avatar}
        wrapperClassName={personaWrapper}
        wrapperStyle={personaStyle}
        bubbleStyle={ASSISTANT_BUBBLE_STYLE}
      >
        <ThinkingContent content={msg.thinking} defaultExpanded={false} />
      </MessageBubble>
    );
  }

  // Assistant turn: text, thinking, and tool blocks can coexist in one real chat bubble.
  return (
    <MessageBubble
      messageId={msg.id}
      avatar={avatar}
      wrapperClassName={personaWrapper}
      wrapperStyle={personaStyle}
      bubbleStyle={ASSISTANT_BUBBLE_STYLE}
    >
      {showThinking && msg.thinking && <ThinkingContent content={msg.thinking} defaultExpanded={false} />}
      {msg.content && <CollapsibleMarkdown content={msg.content} />}
      {msg.toolEvents?.length || msg.cliStdout ? (
        <CliOutputBlock
          events={toCliEvents(msg.toolEvents, msg.cliStdout)}
          status={toCliStatus(msg.toolEvents)}
          defaultExpanded={false}
        />
      ) : null}
    </MessageBubble>
  );
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ReplayMessageList({
  messages,
  autoScroll = true,
  emptyStateLabel = 'Press play to start replay',
  displayMode = 'cinematic',
}: ReplayMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when visible replay content grows. Same assistant turns are
  // merged into one chat bubble, so message count alone misses appended text/tool output.
  const scrollSignature = buildScrollSignature(messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollSignature intentionally tracks merged-message content growth.
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [scrollSignature, autoScroll]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--console-text-tertiary,#888)]">
        <p className="text-sm">{emptyStateLabel}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1" data-auto-scroll={autoScroll ? 'true' : 'false'}>
      {messages.map((msg) => (
        <ReplayMessage key={msg.id} msg={msg} displayMode={displayMode} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
