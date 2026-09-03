import {
  APPROVAL_PRODUCER_IDS,
  type ApprovalProducerId,
  approvalProducerMeta,
  type MeetingIntakeRepairAction,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import {
  areWorktreeIdsEquivalent,
  resolveNavigateTargetWorktreeId,
  scopeWorktreeAliases,
  type WorktreeAliasMap,
} from '@/utils/worktree-id-alias';
import {
  consumePendingWorkspaceNavigation,
  deliverWorkspaceNavigateEvent,
  queuePendingWorkspaceNavigation,
  type WorkspaceNavigationReceipt,
  type WorkspaceNavigationStorage,
} from './workspace-navigation-pending';

export interface NavigateEvent {
  path: string;
  worktreeId?: string;
  action?: 'reveal' | 'open' | 'knowledge-feed';
  line?: number;
  threadId?: string;
  eventId?: string;
}

const OPEN_REVEAL_GRACE_MS = 2000;
const WORKSPACE_NAVIGATION_ACK_ROOM = 'workspace:navigate:ack';
const PENDING_ENTRUSTED_ACTION_KEY = 'cat-cafe:f310:pending-source-action:v1';

export interface EntrustedWorkMessageAction {
  threadId: string;
  messageId: string;
  blockId?: string;
}

export type EntrustedWorkActionTarget =
  | ({ kind: 'message' } & EntrustedWorkMessageAction)
  | { kind: 'approval'; producerId: ApprovalProducerId; proposalId: string };

export function parseEntrustedWorkMessageAction(actionRef: string): EntrustedWorkMessageAction | null {
  const match = /^message:([^:#]+):([^:#]+)(?:#(.+))?$/u.exec(actionRef);
  if (!match?.[1] || !match[2]) return null;
  return { threadId: match[1], messageId: match[2], ...(match[3] ? { blockId: match[3] } : {}) };
}

const MEETING_ACTIONS = new Set<MeetingIntakeRepairAction | 'confirm'>([
  'confirm',
  'retry',
  'regrant',
  'manual_import',
]);

function decodeActionId(encoded: string): string | null {
  try {
    const value = decodeURIComponent(encoded);
    return value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

function resolveMeetingActionTarget(actionRef: string): EntrustedWorkActionTarget | null {
  const meeting = /^\/api\/meeting-intakes\/([^/]+)\/([^/]+)$/u.exec(actionRef);
  if (meeting?.[1] && meeting[2] && MEETING_ACTIONS.has(meeting[2] as MeetingIntakeRepairAction | 'confirm')) {
    const proposalId = decodeActionId(meeting[1]);
    return proposalId ? { kind: 'approval', producerId: 'F292', proposalId } : null;
  }
  return null;
}

function resolveApprovalActionTarget(actionRef: string): EntrustedWorkActionTarget | null {
  const producer = APPROVAL_PRODUCER_IDS.find((producerId) => {
    if (producerId === 'F292' || producerId === 'F306') return false;
    const base = approvalProducerMeta(producerId).decisionEndpointBase;
    return base ? actionRef.startsWith(`${base}/`) : false;
  });
  if (!producer) return null;
  const base = approvalProducerMeta(producer).decisionEndpointBase;
  if (!base) return null;
  const encoded = actionRef.slice(base.length + 1);
  const proposalId = encoded.includes('/') ? null : decodeActionId(encoded);
  return proposalId ? { kind: 'approval', producerId: producer, proposalId } : null;
}

export function resolveEntrustedWorkActionTarget(actionRef: string): EntrustedWorkActionTarget | null {
  const message = parseEntrustedWorkMessageAction(actionRef);
  return message
    ? { kind: 'message', ...message }
    : (resolveMeetingActionTarget(actionRef) ?? resolveApprovalActionTarget(actionRef));
}

function findRichBlock(coordinate: EntrustedWorkMessageAction): HTMLElement | null {
  const messages = document.querySelectorAll<HTMLElement>('[data-message-id]');
  const message = Array.from(messages).find((candidate) => candidate.dataset.messageId === coordinate.messageId);
  if (!message) return null;
  if (!coordinate.blockId) return message;
  return (
    Array.from(message.querySelectorAll<HTMLElement>('[data-rich-block-id]')).find(
      (candidate) => candidate.dataset.richBlockId === coordinate.blockId,
    ) ?? null
  );
}

function revealEntrustedAction(coordinate: EntrustedWorkMessageAction): () => void {
  if (typeof document === 'undefined') return () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  const reveal = () => {
    const target = findRichBlock(coordinate);
    if (!target) return false;
    target.scrollIntoView?.({ block: 'center' });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    try {
      window.sessionStorage.removeItem(PENDING_ENTRUSTED_ACTION_KEY);
    } catch {
      // Session navigation remains best-effort when browser storage is unavailable.
    }
    observer?.disconnect();
    if (timeout) clearTimeout(timeout);
    return true;
  };
  if (!reveal()) {
    observer = new MutationObserver(reveal);
    observer.observe(document.body, { childList: true, subtree: true });
    timeout = setTimeout(() => observer?.disconnect(), 15_000);
  }
  return () => {
    observer?.disconnect();
    if (timeout) clearTimeout(timeout);
  };
}

function persistEntrustedAction(coordinate: EntrustedWorkMessageAction): void {
  try {
    window.sessionStorage.setItem(PENDING_ENTRUSTED_ACTION_KEY, JSON.stringify(coordinate));
  } catch {
    // The canonical action remains the source card; storage only preserves the navigation coordinate.
  }
}

function readPendingEntrustedAction(threadId: string): EntrustedWorkMessageAction | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_ENTRUSTED_ACTION_KEY);
    if (!raw) return null;
    const parsed = parseEntrustedWorkMessageAction(
      (() => {
        const candidate = JSON.parse(raw) as Partial<EntrustedWorkMessageAction>;
        return typeof candidate.threadId === 'string' && typeof candidate.messageId === 'string'
          ? `message:${candidate.threadId}:${candidate.messageId}${
              typeof candidate.blockId === 'string' ? `#${candidate.blockId}` : ''
            }`
          : '';
      })(),
    );
    return parsed?.threadId === threadId ? parsed : null;
  } catch {
    return null;
  }
}

/** Navigate only. The Needs Me projection never invokes the producer mutation itself. */
export function navigateToEntrustedWorkAction(actionRef: string): boolean {
  if (typeof window === 'undefined') return false;
  const target = resolveEntrustedWorkActionTarget(actionRef);
  if (!target || target.kind !== 'message') return false;
  const coordinate: EntrustedWorkMessageAction = target;
  persistEntrustedAction(coordinate);
  const plan = planTeleport({
    threadId: coordinate.threadId,
    messageId: coordinate.messageId,
    currentThreadId: useChatStore.getState().currentThreadId,
  });
  if (plan.scrollNow) {
    scrollToMessage(plan.scrollNow);
    kickTeleportResolve();
    revealEntrustedAction(coordinate);
  } else if (plan.navigateTo) {
    pushThreadRouteWithHistory(plan.navigateTo, window);
  }
  return true;
}

function shouldSuppressReveal(
  data: NavigateEvent,
  recentOpen: { path: string; worktreeId?: string; ts: number } | null | undefined,
  worktreeAliases?: WorktreeAliasMap,
): boolean {
  return (
    recentOpen != null &&
    recentOpen.path === data.path &&
    areWorktreeIdsEquivalent(recentOpen.worktreeId ?? null, data.worktreeId ?? null, worktreeAliases) &&
    Date.now() - recentOpen.ts < OPEN_REVEAL_GRACE_MS
  );
}

function shouldProcessNavigateEvent(data: NavigateEvent, lastEventIdRef: { current: string | null }): boolean {
  if (data.eventId && data.eventId === lastEventIdRef.current) return false;
  if (data.eventId) lastEventIdRef.current = data.eventId;
  return true;
}

export function handleNavigateEvent(
  data: NavigateEvent,
  currentWorktreeId: string | null,
  actions: {
    setWorkspaceWorktreeId: (id: string | null) => void;
    setWorkspaceRevealPath: (path: string | null, originThreadId?: string) => void;
    setWorkspaceOpenFile: (
      path: string | null,
      line: number | null,
      targetWorktreeId?: string | null,
      originThreadId?: string,
    ) => void;
    setWorkspaceMode?: (mode: 'dev' | 'recall') => void;
  },
  recentOpen?: { path: string; worktreeId?: string; ts: number } | null,
  presentationLocked?: boolean,
  worktreeAliases?: WorktreeAliasMap,
): boolean {
  // Phase H: Switch workspace to knowledge feed mode (allowed even when locked)
  if (data.action === 'knowledge-feed') {
    actions.setWorkspaceMode?.('recall');
    return true;
  }

  // F063 Presentation Lock: suppress file-oriented auto-navigation (AC-PL5)
  if (presentationLocked) return false;

  // File-oriented actions: auto-switch back to dev mode so the file is visible
  if (data.action === 'open') {
    actions.setWorkspaceMode?.('dev');
    const targetWorktreeId = resolveNavigateTargetWorktreeId(
      currentWorktreeId,
      data.worktreeId ?? null,
      worktreeAliases,
    );
    if (data.threadId) {
      actions.setWorkspaceOpenFile(data.path, data.line ?? null, targetWorktreeId, data.threadId);
    } else {
      actions.setWorkspaceOpenFile(data.path, data.line ?? null, targetWorktreeId);
    }
    return true;
  }

  if (shouldSuppressReveal(data, recentOpen, worktreeAliases)) {
    return false;
  }

  if (data.worktreeId && !areWorktreeIdsEquivalent(data.worktreeId, currentWorktreeId, worktreeAliases)) {
    actions.setWorkspaceWorktreeId(data.worktreeId);
  }
  actions.setWorkspaceMode?.('dev');
  if (data.threadId) {
    actions.setWorkspaceRevealPath(data.path, data.threadId);
  } else {
    actions.setWorkspaceRevealPath(data.path);
  }
  return true;
}

function sessionNavigationStorage(): WorkspaceNavigationStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function useWorkspaceNavigate(
  threadId: string | null,
  options: { isChatRoute: boolean; isWorkspaceVisible?: boolean; enabled?: boolean } = { isChatRoute: true },
) {
  const setWorkspaceWorktreeId = useChatStore((s) => s.setWorkspaceWorktreeId);
  const setWorkspaceRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const setWorkspaceOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const worktreeAliases = useChatStore((s) => s.workspaceWorktreeAliases);
  const worktreeAliasesProjectPath = useChatStore((s) => s.workspaceWorktreeAliasesProjectPath);
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const presentationLocked = useChatStore((s) => s.presentationLock != null);
  const scopedWorktreeAliases = scopeWorktreeAliases(worktreeAliases, worktreeAliasesProjectPath, currentProjectPath);
  const lastEventIdRef = useRef<string | null>(null);
  const recentOpenRef = useRef<{ path: string; worktreeId?: string; ts: number } | null>(null);
  const isWorkspaceVisible = options.isWorkspaceVisible ?? true;

  const applyNavigate = useCallback(
    (data: NavigateEvent): boolean => {
      const state = useChatStore.getState();
      const processed = handleNavigateEvent(
        data,
        state.workspaceWorktreeId,
        {
          setWorkspaceWorktreeId,
          setWorkspaceRevealPath,
          setWorkspaceOpenFile,
          setWorkspaceMode,
        },
        recentOpenRef.current,
        state.presentationLock != null,
        scopedWorktreeAliases,
      );
      if (processed && data.action === 'open') {
        recentOpenRef.current = { path: data.path, worktreeId: data.worktreeId, ts: Date.now() };
      }
      return processed;
    },
    [scopedWorktreeAliases, setWorkspaceMode, setWorkspaceOpenFile, setWorkspaceRevealPath, setWorkspaceWorktreeId],
  );
  const deliveryStateRef = useRef({
    threadId,
    isChatRoute: options.isChatRoute,
    isWorkspaceVisible,
    applyNavigate,
  });
  deliveryStateRef.current = {
    threadId,
    isChatRoute: options.isChatRoute,
    isWorkspaceVisible,
    applyNavigate,
  };

  useEffect(() => {
    if (options.enabled === false || !options.isChatRoute || !threadId || !isWorkspaceVisible) return;
    const storage = sessionNavigationStorage();
    if (!storage) return;
    consumePendingWorkspaceNavigation({
      storage,
      threadId,
      canDisplay: true,
      presentationLocked,
      apply: applyNavigate,
    });
  }, [applyNavigate, isWorkspaceVisible, options.enabled, options.isChatRoute, presentationLocked, threadId]);

  useEffect(() => {
    if (options.enabled === false || !options.isChatRoute || !threadId) return;
    const pending = readPendingEntrustedAction(threadId);
    if (!pending) return;
    return revealEntrustedAction(pending);
  }, [options.enabled, options.isChatRoute, threadId]);

  useEffect(() => {
    if (options.enabled === false) return;
    const apiUrl = new URL(API_URL);
    const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });

    socket.emit('join_room', WORKSPACE_NAVIGATION_ACK_ROOM);

    const handler = (data: NavigateEvent, acknowledge?: (receipt: WorkspaceNavigationReceipt) => void) => {
      if (!shouldProcessNavigateEvent(data, lastEventIdRef)) return;
      const deliveryState = deliveryStateRef.current;
      const storage = sessionNavigationStorage();
      const queuedData =
        data.threadId || !deliveryState.threadId ? data : { ...data, threadId: deliveryState.threadId };
      const receipt = deliverWorkspaceNavigateEvent({
        data,
        activeThreadId: deliveryState.threadId,
        isChatRoute: deliveryState.isChatRoute,
        isWorkspaceVisible: deliveryState.isWorkspaceVisible,
        presentationLocked: useChatStore.getState().presentationLock != null,
        apply: deliveryState.applyNavigate,
        persist: () => (storage ? queuePendingWorkspaceNavigation(storage, queuedData) : false),
      });
      if (acknowledge) {
        acknowledge(receipt);
      }
    };

    socket.on('workspace:navigate', handler);

    return () => {
      socket.off('workspace:navigate', handler);
      socket.disconnect();
    };
  }, [options.enabled]);
}
