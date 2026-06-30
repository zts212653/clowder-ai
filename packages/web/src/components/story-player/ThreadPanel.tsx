'use client';

/**
 * F252 Phase E PR E-4 — Thread Panel
 *
 * Per-thread rendering panel within MultiCamStage. Shows thread name,
 * participant cats, and the thread's visible messages using Hub-native
 * ReplayMessageList. Accepts a visual mode (spotlight/active/dim) that
 * drives CSS effects.
 *
 * AC-E3: Spotlight = glow border, Dim = backdrop-blur + reduced opacity
 * AC-E5: Used as a child of MultiCamStage layout
 */

import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import { ReplayMessageList } from './ReplayMessageList';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PanelMode = 'spotlight' | 'active' | 'dim';

export interface ThreadPanelProps {
  threadId: string;
  threadName: string;
  participants: string[];
  mode: PanelMode;
  messages: ReplayChatMessage[];
  /** Display mode for message rendering */
  displayMode?: 'cinematic' | 'faithful';
}

// ---------------------------------------------------------------------------
// Styles per mode (CSS-only spotlight/dim effects — AC-E3)
// ---------------------------------------------------------------------------

const MODE_STYLES: Record<PanelMode, React.CSSProperties> = {
  spotlight: {
    boxShadow: '0 0 20px rgba(168,85,247,0.25), 0 0 40px rgba(168,85,247,0.1)',
    border: '1.5px solid rgba(168,85,247,0.5)',
    transition: 'all 300ms ease',
  },
  active: {
    border: '1px solid var(--console-border, rgba(255,255,255,0.1))',
    transition: 'all 300ms ease',
  },
  dim: {
    border: '1px solid rgba(255,255,255,0.05)',
    opacity: 0.55,
    filter: 'brightness(0.7)',
    transition: 'all 300ms ease',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ThreadPanel({ threadId, threadName, participants, mode, messages, displayMode }: ThreadPanelProps) {
  return (
    <div
      data-testid={`thread-panel-${threadId}`}
      data-panel-mode={mode}
      className="h-full flex flex-col rounded-lg overflow-hidden bg-[var(--console-shell-bg,#111)]"
      style={MODE_STYLES[mode]}
    >
      {/* Thread header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--console-border,rgba(255,255,255,0.1))]">
        {/* Thread activity indicator */}
        <span
          className={`w-2 h-2 rounded-full ${mode === 'spotlight' ? 'bg-purple-400 animate-pulse' : mode === 'active' ? 'bg-green-400' : 'bg-gray-600'}`}
        />
        <span
          className="text-[length:var(--console-font-compact,13px)] font-medium text-[var(--console-text-primary,#fff)] truncate"
          title={threadName}
        >
          {threadName}
        </span>
        {participants.length > 0 && (
          <span className="text-[length:var(--console-font-micro,10px)] text-[var(--console-text-tertiary,#888)] truncate">
            {participants.join(', ')}
          </span>
        )}
      </div>

      {/* Message area */}
      <div className={`flex-1 overflow-y-auto px-3 py-2 ${mode === 'dim' ? 'pointer-events-none' : ''}`}>
        {messages.length > 0 ? (
          <ReplayMessageList messages={messages} autoScroll={mode === 'spotlight'} displayMode={displayMode} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <span className="text-[length:var(--console-font-xs,11px)] text-[var(--console-text-tertiary,#888)]">
              {mode === 'dim' ? 'Idle' : 'Waiting for events...'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
