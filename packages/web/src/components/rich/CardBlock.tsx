'use client';

import { useCallback, useEffect, useState } from 'react';
import { InvestigationProgress } from '@/components/concierge/InvestigationProgress';
import { MarkdownContent } from '@/components/MarkdownContent';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import {
  handleProfileUpdateDecisionAction,
  isProfileUpdateDecisionAction,
  useProfileUpdateTerminalSync,
} from './profile-update-actions';

const TONE_STYLES: Record<string, string> = {
  info: 'border-l-conn-blue-ring bg-conn-blue-bg ',
  success: 'border-l-conn-green-ring bg-conn-green-bg ',
  warning: 'border-l-yellow-400 bg-[var(--semantic-warning-surface)] ',
  danger: 'border-l-conn-red-ring bg-conn-red-bg ',
};

export interface CardConfirmationEntry {
  id: string;
  messageId: string;
  status: 'rendered' | 'confirmed' | 'cancelled';
  action: { kind: string; [key: string]: unknown };
}

function getPlanId(payload?: Record<string, unknown>): string {
  return typeof payload?.planId === 'string' ? payload.planId : '';
}

function findRestoredTriageStatus(
  confirmations: CardConfirmationEntry[] | undefined,
  payload?: Record<string, unknown>,
): 'confirmed' | 'cancelled' | null {
  const planId = getPlanId(payload);
  if (!planId) return null;

  for (const entry of confirmations ?? []) {
    if (entry.status !== 'confirmed' && entry.status !== 'cancelled') continue;
    if (entry.action.kind !== 'concierge_triage_confirm' && entry.action.kind !== 'concierge_triage_cancel') continue;
    if (entry.action.planId === planId) return entry.status;
  }
  return null;
}

/** P1-1 fix: find investigationJobId from restored confirmations for intent=investigate cards */
function findRestoredInvestigationJobId(
  confirmations: CardConfirmationEntry[] | undefined,
  payload?: Record<string, unknown>,
): string | null {
  const planId = getPlanId(payload);
  if (!planId) return null;

  for (const entry of confirmations ?? []) {
    if (entry.status !== 'confirmed') continue;
    if (entry.action.kind !== 'concierge_triage_confirm') continue;
    if (entry.action.planId !== planId) continue;
    if (entry.action.intent !== 'investigate') continue;
    const jobId = entry.action.investigationJobId;
    if (typeof jobId === 'string' && jobId) return jobId;
  }
  return null;
}

function readTargetCatsSelection(payload?: Record<string, unknown>): string[] {
  if (!Array.isArray(payload?.targetCats)) return [];
  return payload.targetCats.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function CardBlock({
  block,
  messageId,
  confirmations,
}: {
  block: RichCardBlock;
  messageId?: string;
  confirmations?: CardConfirmationEntry[];
}) {
  const toneStyle = TONE_STYLES[block.tone ?? 'info'] ?? TONE_STYLES.info;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  // F229 AC-B2: investigation job tracking after triage confirm with intent=investigate
  const [investigationJobId, setInvestigationJobId] = useState<string | null>(null);
  useProfileUpdateTerminalSync({ block, messageId });

  // P1-1 fix: restore investigationJobId from persisted confirmations on mount/re-render.
  // When panel reopens, confirmations include investigationJobId for investigate intents.
  // This triggers InvestigationProgress which polls the persisted job and renders the report.
  useEffect(() => {
    if (investigationJobId) return; // already set (live confirm flow)
    // Check each triage_confirm action in the block for matching restored confirmations
    for (const action of block.actions ?? []) {
      if (action.action !== 'concierge_triage_confirm') continue;
      const restoredJobId = findRestoredInvestigationJobId(confirmations, action.payload);
      if (restoredJobId) {
        setInvestigationJobId(restoredJobId);
        break;
      }
    }
  }, [confirmations, block.actions, investigationJobId]);

  const copyToClipboard = useCallback(async (payload?: Record<string, unknown>) => {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text) {
      setError('没有可复制的内容');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAction('copy-to-clipboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : '复制失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const resynthesizeTts = useCallback(
    async (payload?: Record<string, unknown>) => {
      if (!messageId) {
        return;
      }
      if (!payload) {
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const res = await apiFetch('/api/tts/resynthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: payload.text, catId: payload.catId }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }

        const data = (await res.json()) as { audioUrl: string; durationSec?: number };

        // Replace this card with an audio block
        useChatStore.getState().updateRichBlock(messageId, block.id, {
          kind: 'audio',
          title: undefined,
          bodyMarkdown: undefined,
          tone: undefined,
          fields: undefined,
          actions: undefined,
          url: data.audioUrl,
          text: payload.text as string,
          durationSec: data.durationSec,
          mimeType: 'audio/wav',
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : '重新合成失败');
      } finally {
        setLoading(false);
      }
    },
    [messageId, block.id],
  );

  // ---------------------------------------------------------------------------
  // F229 PR-A3b: Concierge card action handlers (§1a/§1b/§2)
  // ---------------------------------------------------------------------------

  const handleConciergeTeleport = useCallback((payload?: Record<string, unknown>) => {
    const threadId = typeof payload?.threadId === 'string' ? payload.threadId : '';
    const messageId = typeof payload?.messageId === 'string' ? payload.messageId : undefined;
    if (!threadId) return;

    // INV-7: collapse surface so user's intent has transferred
    useConciergeStore.getState().onNavigationAction();

    const currentThreadId = useChatStore.getState().currentThreadId;
    if (messageId) {
      const plan = planTeleport({ threadId, messageId, currentThreadId });
      if (plan.scrollNow) {
        // Same thread: bubble already collapsed (onNavigationAction above),
        // scroll underlying chat to target + kick resolver for out-of-window targets.
        // Matches useTeleport.ts same-thread path (cloud review P2 fix).
        scrollToMessage(plan.scrollNow);
        kickTeleportResolve();
      } else if (plan.navigateTo) {
        // Bug1 fix: pathname route (/thread/X) + pushState — chat route reads threadId
        // from pathname only ((chat)/layout.tsx); /?threadId= query has no consumer → lobby.
        // Matches useTeleport.ts:91 (the already-shipped cross-thread teleport path).
        pushThreadRouteWithHistory(plan.navigateTo, window);
      }
    } else {
      // No messageId — navigate to thread via pathname route
      // (Bug1: was /?threadId= → getThreadIdFromPathname('/') = 'default' = lobby).
      pushThreadRouteWithHistory(threadId, window);
    }
  }, []);

  const handleConciergeGo = useCallback((payload?: Record<string, unknown>) => {
    const targetThreadId = typeof payload?.targetThreadId === 'string' ? payload.targetThreadId : '';
    if (!targetThreadId) return;

    // INV-7: collapse surface
    useConciergeStore.getState().onNavigationAction();
    // Bug1 fix: pathname route, not /?threadId= query (lobby fallback).
    pushThreadRouteWithHistory(targetThreadId, window);
  }, []);

  const handleConciergeRelay = useCallback(
    async (payload?: Record<string, unknown>) => {
      if (!payload) return;
      // Cloud R4 P1: one-shot guard — prevent duplicate relay dispatch on double-click.
      // After first success, copiedAction is 'concierge_relay'; early-return blocks re-post.
      if (copiedAction === 'concierge_relay') return;
      const targetThreadId = typeof payload.targetThreadId === 'string' ? payload.targetThreadId : '';
      const targetCats = Array.isArray(payload.targetCats) ? (payload.targetCats as string[]) : [];
      const originalText = typeof payload.originalText === 'string' ? payload.originalText : '';
      const sourceMessageId = typeof payload.sourceMessageId === 'string' ? payload.sourceMessageId : '';

      // INV-E1: all required fields present
      if (!targetThreadId || targetCats.length === 0 || !originalText || !sourceMessageId) {
        setError('传话参数不完整');
        return;
      }

      setLoading(true);
      setError(null);
      const store = useConciergeStore.getState();

      // R-review P1 fix: increment pendingRelayCount BEFORE dispatch → ball enters handoff
      store.onRelayDispatching();

      try {
        const conciergeThreadId = store.threadId;
        if (!conciergeThreadId) {
          throw new Error('Concierge thread not initialized');
        }

        const res = await apiFetch('/api/concierge/relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetThreadId, targetCats, originalText, sourceMessageId, conciergeThreadId }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }

        // Relay dispatched successfully → exit handoff → idle (NOT found).
        // Spec §0: found badge waits for target cat's actual cross_post reply
        // message arriving in concierge thread, not dispatch ACK.
        store.onRelayDispatched();
        // Mark this card as completed
        setCopiedAction('concierge_relay');
      } catch (err) {
        // Dispatch failed → revert handoff without adding unseen
        useConciergeStore.getState().onRelayFailed();
        setError(err instanceof Error ? err.message : '传话失败');
      } finally {
        setLoading(false);
      }
    },
    [copiedAction],
  );

  const handleConciergePeek = useCallback(
    async (payload?: Record<string, unknown>) => {
      const threadId = typeof payload?.threadId === 'string' ? payload.threadId : '';
      const msgId = typeof payload?.messageId === 'string' ? payload.messageId : '';
      if (!threadId || !msgId) return;

      setLoading(true);
      setError(null);

      try {
        const res = await apiFetch(`/api/concierge/peek?threadId=${threadId}&messageId=${msgId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as {
          window: Array<{ id: string; content: string; catId: string | null; userId: string; isTarget: boolean }>;
        };

        // Update the card's bodyMarkdown to show the peeked content inline
        if (messageId) {
          const peekContent = data.window
            .map((m) => {
              const prefix = m.isTarget ? '**→ ' : '  ';
              const sender = m.catId ? `🐱 ${m.catId}` : `👤 ${m.userId}`;
              const suffix = m.isTarget ? ' ←**' : '';
              return `${prefix}${sender}: ${m.content?.slice(0, 200) ?? ''}${suffix}`;
            })
            .join('\n\n');

          useChatStore.getState().updateRichBlock(messageId, block.id, {
            ...block,
            bodyMarkdown: peekContent,
            actions: block.actions?.filter((a) => a.action !== 'concierge_peek'),
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '查看失败');
      } finally {
        setLoading(false);
      }
    },
    [messageId, block],
  );

  // F229 Phase B: propose_thread — request new thread creation
  const handleConciergePropose = useCallback(
    async (payload?: Record<string, unknown>) => {
      if (!payload) return;
      if (copiedAction === 'concierge_propose_thread') return; // one-shot guard
      const title = typeof payload.title === 'string' ? payload.title : '';
      const description = typeof payload.description === 'string' ? payload.description : '';
      if (!title) {
        setError('标题不能为空');
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/concierge/propose-thread', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { threadId?: string };
        setCopiedAction('concierge_propose_thread');
        // Navigate to the new thread if returned
        if (data.threadId) {
          useConciergeStore.getState().onNavigationAction();
          pushThreadRouteWithHistory(data.threadId, window);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '开新调查失败');
      } finally {
        setLoading(false);
      }
    },
    [copiedAction],
  );

  // F229 Phase B: triage confirm/cancel handlers
  const handleTriageConfirm = useCallback(
    async (payload?: Record<string, unknown>) => {
      const planId = typeof payload?.planId === 'string' ? payload.planId : '';
      if (!planId) return;
      if (copiedAction === 'concierge_triage_confirm') return; // one-shot guard
      setLoading(true);
      setError(null);
      try {
        const selectedTargetCats = readTargetCatsSelection(payload);
        const requestInit =
          selectedTargetCats.length > 0
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ targetCats: selectedTargetCats }),
              }
            : { method: 'POST' };
        const res = await apiFetch(`/api/concierge/triage/${planId}/confirm`, requestInit);
        if (!res.ok) throw new Error(`确认失败: ${res.status}`);
        setCopiedAction('concierge_triage_confirm');

        // If backend returns a thread, the confirmed action has transferred the user's intent:
        // go => target thread, propose_thread => newly-created investigation thread.
        // investigate => extract investigationJobId and start polling (AC-B2).
        const intent = typeof payload?.intent === 'string' ? payload.intent : '';
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const threadId = typeof data.threadId === 'string' ? data.threadId : '';
        if ((intent === 'go' || intent === 'propose_thread') && threadId) {
          useConciergeStore.getState().onNavigationAction();
          pushThreadRouteWithHistory(threadId, window);
        } else if (intent === 'investigate') {
          // AC-B2: extract investigationJobId → InvestigationProgress polls and renders report
          const jobId = typeof data.investigationJobId === 'string' ? data.investigationJobId : '';
          if (jobId) {
            setInvestigationJobId(jobId);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '确认失败');
      } finally {
        setLoading(false);
      }
    },
    [copiedAction],
  );

  const handleTriageCancel = useCallback(
    async (payload?: Record<string, unknown>) => {
      const planId = typeof payload?.planId === 'string' ? payload.planId : '';
      if (!planId) return;
      if (copiedAction === 'concierge_triage_cancel') return; // one-shot guard
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/concierge/triage/${planId}/cancel`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(`取消失败: ${res.status}`);
        setCopiedAction('concierge_triage_cancel');
      } catch (err) {
        setError(err instanceof Error ? err.message : '取消失败');
      } finally {
        setLoading(false);
      }
    },
    [copiedAction],
  );

  const handleAction = useCallback(
    async (action: string, payload?: Record<string, unknown>) => {
      if (action === 'copy-to-clipboard') {
        await copyToClipboard(payload);
        return;
      }
      if (action === 'tts-resynthesize') {
        await resynthesizeTts(payload);
        return;
      }
      // F229 PR-A3b: Concierge card actions (§2 CardBlock:90 registration point)
      if (action === 'concierge_teleport') {
        handleConciergeTeleport(payload);
        return;
      }
      if (action === 'concierge_go') {
        handleConciergeGo(payload);
        return;
      }
      if (action === 'concierge_relay') {
        await handleConciergeRelay(payload);
        return;
      }
      if (action === 'concierge_peek') {
        await handleConciergePeek(payload);
        return;
      }
      // F229 Phase B: propose_thread action
      if (action === 'concierge_propose_thread') {
        await handleConciergePropose(payload);
        return;
      }
      // F229 Phase B: triage confirm/cancel actions
      if (action === 'concierge_triage_confirm') {
        await handleTriageConfirm(payload);
        return;
      }
      if (action === 'concierge_triage_cancel') {
        await handleTriageCancel(payload);
        return;
      }
      // F231 Phase C: profile-update confirmation card (generic card-block actions).
      if (isProfileUpdateDecisionAction(action)) {
        await handleProfileUpdateDecisionAction({
          action,
          block,
          copiedAction,
          messageId,
          payload,
          setCopiedAction,
          setError,
          setLoading,
        });
        return;
      }
      // Defense-in-depth (F225 dogfood): a card whose action this build doesn't handle — e.g. a stale
      // browser bundle rendering a newer `handoff:approve` card via this generic renderer instead of
      // the dedicated one — would silently no-op. Warn so the dead button self-diagnoses (→ refresh).
      console.warn(
        `[CardBlock] unhandled card action "${action}" — the app bundle may be stale; hard-refresh (Cmd+Shift+R).`,
      );
    },
    [
      copyToClipboard,
      resynthesizeTts,
      handleConciergeTeleport,
      handleConciergeGo,
      handleConciergeRelay,
      handleConciergePeek,
      handleConciergePropose,
      handleTriageConfirm,
      handleTriageCancel,
      block,
      copiedAction,
      messageId,
    ],
  );

  return (
    <div className={`border-l-4 rounded-r-lg p-3 ${toneStyle}`}>
      <div className="font-medium text-sm">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-cafe-secondary [&_.markdown-content]:text-xs [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {block.fields && block.fields.length > 0 && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
          {block.fields.map((f, i) => (
            <div key={`${f.label}:${f.value}:${i}`} className="text-xs">
              <span className="text-cafe-secondary">{f.label}:</span>{' '}
              <span className="font-mono break-all">{f.value}</span>
            </div>
          ))}
        </div>
      )}
      {block.actions && block.actions.length > 0 && (
        <div className="mt-2 flex gap-2">
          {block.actions.map((a, i) => {
            const restoredTriageStatus =
              a.action === 'concierge_triage_confirm' || a.action === 'concierge_triage_cancel'
                ? findRestoredTriageStatus(confirmations, a.payload)
                : null;
            const actionCompleted =
              copiedAction === a.action ||
              (a.action === 'concierge_triage_confirm' && restoredTriageStatus === 'confirmed') ||
              (a.action === 'concierge_triage_cancel' && restoredTriageStatus === 'cancelled');
            const triageTerminal =
              restoredTriageStatus === 'confirmed' ||
              restoredTriageStatus === 'cancelled' ||
              copiedAction === 'concierge_triage_confirm' ||
              copiedAction === 'concierge_triage_cancel';
            const disabled =
              loading ||
              (a.action === 'concierge_relay' && copiedAction === 'concierge_relay') ||
              ((a.action === 'concierge_triage_confirm' || a.action === 'concierge_triage_cancel') && triageTerminal);
            const label = loading
              ? a.action === 'tts-resynthesize'
                ? '合成中...'
                : '处理中...'
              : actionCompleted
                ? a.action === 'concierge_triage_confirm'
                  ? '已确认'
                  : a.action === 'concierge_triage_cancel'
                    ? '已取消'
                    : '已复制'
                : a.label;

            return (
              <button
                key={`${a.action}:${a.label}:${i}`}
                type="button"
                disabled={disabled}
                onClick={() => handleAction(a.action, a.payload)}
                className="text-xs px-2 py-1 rounded bg-[var(--semantic-warning-surface)] hover:bg-[var(--semantic-warning-surface)] text-conn-amber-text border border-conn-amber-ring disabled:opacity-50 transition-colors"
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {error && <div className="mt-1 text-xs text-conn-red-text">{error}</div>}
      {/* F229 AC-B2: Investigation progress/report after triage confirm with intent=investigate */}
      {investigationJobId && <InvestigationProgress jobId={investigationJobId} />}
    </div>
  );
}
