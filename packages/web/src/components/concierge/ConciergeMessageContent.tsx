/**
 * F229 AC-A3 Bug2: ConciergeMessageContent — inline marker buttons (method A)
 *
 * Replaces raw `{msg.content}` text rendering in ConciergePanel.
 * Scans content for [跳过去 Rn] / [原地看 Rn] markers and renders them as
 * clickable inline buttons. Non-marker text rendered as-is.
 *
 * AC-2: teleport → pushThreadRouteWithHistory (path, not query — Bug1 fix)
 * AC-3: peek with messageId → inline peek button → API call
 * AC-4: peek without messageId → validator skips → no matching action → plain text
 * AC-5: no raw [verb Rn] bracket text ever visible
 * AC-6: KD-19 fallback actions (no handle/verb) → card buttons below still work
 */

import { type ReactNode, useCallback, useState } from 'react';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';

// ---------------------------------------------------------------------------
// Types — mirrors ConciergeAction from API (only fields we need)
// ---------------------------------------------------------------------------

interface InlineAction {
  action: string;
  label: string;
  handle?: string;
  verb?: string;
  payload: {
    threadId: string;
    messageId?: string;
  };
}

export interface ConciergeMessageContentProps {
  content: string;
  actions: InlineAction[];
  /** Parent message ID — needed for peek inline expansion. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// Marker pattern — same as API validator
// ---------------------------------------------------------------------------

const MARKER_PATTERN = /\[(跳过去|原地看)\s+(R\d+)\]/g;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConciergeMessageContent({ content, actions }: ConciergeMessageContentProps) {
  const [peekLoading, setPeekLoading] = useState<string | null>(null);
  const [peekContent, setPeekContent] = useState<Record<string, string>>({});
  const [peekError, setPeekError] = useState<string | null>(null);

  // Build lookup: "verb:handle" → action
  const actionMap = new Map<string, InlineAction>();
  for (const a of actions) {
    if (a.handle && a.verb) {
      actionMap.set(`${a.verb}:${a.handle}`, a);
    }
  }

  const handleTeleport = useCallback((action: InlineAction) => {
    const { threadId, messageId: msgId } = action.payload;
    if (!threadId) return;

    useConciergeStore.getState().onNavigationAction();

    const currentThreadId = useChatStore.getState().currentThreadId;
    if (msgId) {
      const plan = planTeleport({ threadId, messageId: msgId, currentThreadId });
      if (plan.scrollNow) {
        // Same thread: scroll to target message + kick resolver for out-of-window targets.
        // Matches CardBlock.tsx same-thread path (gpt52 review P1 fix).
        scrollToMessage(plan.scrollNow);
        kickTeleportResolve();
      } else if (plan.navigateTo) {
        // Cross thread: pathname route (/thread/X) + pushState (Bug1 fix parity).
        pushThreadRouteWithHistory(plan.navigateTo, window);
      }
    } else {
      // No messageId — navigate to thread via pathname route
      pushThreadRouteWithHistory(threadId, window);
    }
  }, []);

  const handlePeek = useCallback(async (action: InlineAction, handle: string) => {
    const { threadId, messageId: msgId } = action.payload;
    if (!threadId || !msgId) return;

    setPeekLoading(handle);
    setPeekError(null);

    try {
      const res = await apiFetch(`/api/concierge/peek?threadId=${threadId}&messageId=${msgId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as {
        window: Array<{ id: string; content: string; catId: string | null; userId: string; isTarget: boolean }>;
      };

      const rendered = data.window
        .map((m) => {
          const prefix = m.isTarget ? '→ ' : '  ';
          const sender = m.catId ? `🐱 ${m.catId}` : `👤 ${m.userId}`;
          return `${prefix}${sender}: ${m.content?.slice(0, 200) ?? ''}`;
        })
        .join('\n');

      setPeekContent((prev) => ({ ...prev, [handle]: rendered }));
    } catch (err) {
      setPeekError(err instanceof Error ? err.message : '查看失败');
    } finally {
      setPeekLoading(null);
    }
  }, []);

  // Parse content and build segments
  const segments: ReactNode[] = [];
  let lastIndex = 0;
  let keyCounter = 0;

  for (const match of content.matchAll(MARKER_PATTERN)) {
    const verb = match[1];
    const handle = match[2];
    const matchIndex = match.index;

    // Text before this marker
    if (matchIndex > lastIndex) {
      segments.push(content.slice(lastIndex, matchIndex));
    }

    const lookupKey = `${verb}:${handle}`;
    const action = actionMap.get(lookupKey);

    if (action) {
      // Matching action found — render inline button
      const isTeleport = action.action === 'concierge_teleport';
      const isPeek = action.action === 'concierge_peek';
      const buttonKey = `marker-${keyCounter++}`;

      segments.push(
        <button
          key={buttonKey}
          type="button"
          onClick={() => {
            if (isTeleport) handleTeleport(action);
            if (isPeek) handlePeek(action, handle);
          }}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: isTeleport ? 'var(--cafe-primary-soft, #e0e7ff)' : 'var(--cafe-accent-soft, #fef3c7)',
            color: isTeleport ? 'var(--cafe-primary, #4f46e5)' : 'var(--cafe-accent, #d97706)',
            border: 'none',
          }}
          title={action.label}
          disabled={peekLoading === handle}
        >
          {isPeek ? '👁 ' : '→ '}
          {verb} {handle}
        </button>,
      );

      // Show inline peek content if loaded
      if (isPeek && peekContent[handle]) {
        segments.push(
          <div
            key={`peek-${handle}`}
            className="mt-1 mb-1 p-2 rounded text-xs"
            style={{
              backgroundColor: 'var(--cafe-surface-sunken, #f5f5f4)',
              whiteSpace: 'pre-wrap',
              borderLeft: '2px solid var(--cafe-accent, #d97706)',
            }}
          >
            {peekContent[handle]}
          </div>,
        );
      }
    } else {
      // No matching action — degrade to plain text label (AC-4, AC-5)
      // Show verb + handle as subtle text, no brackets, no button
      segments.push(
        <span
          key={`degraded-${keyCounter++}`}
          className="text-xs"
          style={{ color: 'var(--cafe-text-muted)', opacity: 0.7 }}
        >
          {verb} {handle}
        </span>,
      );
    }

    lastIndex = matchIndex + match[0].length;
  }

  // Remaining text after last marker
  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex));
  }

  // Show peek error if any
  if (peekError) {
    segments.push(
      <div key="peek-error" className="text-xs mt-1" style={{ color: 'var(--cafe-error, #ef4444)' }}>
        {peekError}
      </div>,
    );
  }

  return <>{segments}</>;
}
