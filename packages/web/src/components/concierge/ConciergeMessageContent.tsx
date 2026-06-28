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

import { Children, type ReactNode, useCallback, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
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
// BUG-UX-4: Strip internal cat signatures and @-mentions from user-visible text.
// Duty cat replies may contain trailing `[昵称/模型🐾]` signatures and `@co-creator`
// routing mentions that leak internal team structure to end users.
// ---------------------------------------------------------------------------

/** Matches cat signature patterns: [nickname/model🐾] or [nickname🐾] */
const CAT_SIGNATURE_RE = /\[[\w一-鿿-]+(?:\/[\w一-鿿.-]+)?🐾\]\s*/g;

/** Matches internal cat/operator routing mentions (whole word, not inside URLs).
 *  R2 P2 fix: added documented aliases (gemini25, gemini-35, hyphenated opus variants).
 *  Uses lookbehind (^|\s) to anchor start; negative lookahead (?![...]) to anchor end.
 *  Cloud R4 root-cause fix: replaced fragile positive lookahead (enumerating allowed
 *  trailing chars — kept missing CJK, full-width punct, etc.) with robust negative
 *  lookahead: "handle ends here if not followed by an ASCII identifier character." */
const INTERNAL_MENTION_RE =
  /(?:^|\s)@(?:l\.s\.|landy|you|opus(?:-?4[678])?|sonnet|fable5|codex|gpt52|spark|gemini(?:-?(?:25|35))?|antigravity|antig-opus)(?![a-zA-Z0-9_-])/gi;

/** Clean internal markers from user-visible concierge content */
function stripInternalMarkers(text: string): string {
  return text.replace(CAT_SIGNATURE_RE, '').replace(INTERNAL_MENTION_RE, '').trim();
}

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

  const handlePeek = useCallback(
    async (action: InlineAction, handle: string) => {
      // BUG-UX-8: toggle — if already showing, collapse on re-click
      if (peekContent[handle]) {
        setPeekContent((prev) => {
          const next = { ...prev };
          delete next[handle];
          return next;
        });
        return;
      }

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
    },
    [peekContent],
  );

  // BUG-UX-4: strip internal team markers before rendering
  const cleanContent = stripInternalMarkers(content);

  // ---------------------------------------------------------------------------
  // BUG-UX-7 P1+P2 fix: Process markers inline within MarkdownContent's text
  // pipeline via textProcessor. This fixes two review findings:
  //   P1: markers inside code blocks are never processed (code/pre use separate
  //       component overrides that don't call textProcessor)
  //   P2: single MarkdownContent instance → single <div.markdown-content> → single
  //       <p> for inline text, no block-level breakage between segments
  // ---------------------------------------------------------------------------
  const processMarkers = (children: ReactNode): ReactNode => {
    return Children.map(children, (child) => {
      if (typeof child !== 'string') return child;

      const parts: ReactNode[] = [];
      let lastIdx = 0;
      const re = new RegExp(MARKER_PATTERN.source, 'g');
      let match: RegExpExecArray | null;

      while ((match = re.exec(child)) !== null) {
        if (match.index > lastIdx) {
          parts.push(child.slice(lastIdx, match.index));
        }

        const verb = match[1];
        const handle = match[2];
        const action = actionMap.get(`${verb}:${handle}`);

        if (action) {
          const isTeleport = action.action === 'concierge_teleport';
          const isPeek = action.action === 'concierge_peek';

          parts.push(
            <button
              key={`m-${handle}-${match.index}`}
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
              {action.action === 'concierge_teleport' ? '跳过去' : '原地看'} {handle}
            </button>,
          );
        } else {
          // No matching action — degrade to plain text label (AC-4, AC-5)
          parts.push(
            <span
              key={`d-${handle}-${match.index}`}
              className="text-xs"
              style={{ color: 'var(--cafe-text-muted)', opacity: 0.7 }}
            >
              {verb} {handle}
            </span>,
          );
        }

        lastIdx = match.index + match[0].length;
      }

      if (lastIdx === 0) return child; // No markers in this text node
      if (lastIdx < child.length) parts.push(child.slice(lastIdx));
      // Return array (not Fragment) — Children.map flattens arrays, allowing
      // subsequent withMentionsAndLinks to process each string/element individually.
      return parts;
    });
  };

  return (
    <>
      <MarkdownContent content={cleanContent} disableCommandPrefix textProcessor={processMarkers} />
      {/* BUG-UX-8: Peek content as collapsible blocks below, with dismiss button */}
      {Object.entries(peekContent).map(([handle, text]) => (
        <div
          key={`peek-${handle}`}
          className="mt-1 mb-1 p-2 rounded text-xs relative"
          style={{
            backgroundColor: 'var(--cafe-surface-sunken, #f5f5f4)',
            whiteSpace: 'pre-wrap',
            borderLeft: '2px solid var(--cafe-accent, #d97706)',
          }}
        >
          <button
            type="button"
            onClick={() =>
              setPeekContent((prev) => {
                const next = { ...prev };
                delete next[handle];
                return next;
              })
            }
            className="absolute top-1 right-1 text-xs cursor-pointer opacity-50 hover:opacity-100 px-1"
            title="收起"
          >
            ✕
          </button>
          {text}
        </div>
      ))}
      {peekError && (
        <div className="text-xs mt-1" style={{ color: 'var(--cafe-error, #ef4444)' }}>
          {peekError}
        </div>
      )}
    </>
  );
}
