'use client';

/**
 * F229 PR-A3a: conciergeStore — 猫猫球前台猫前端状态
 *
 * 核心设计（micro-spec §1）：
 *   ballState = 纯投影函数，永远不进 store（INV-2）
 *   所有可见状态由 projectBallState(inputs) 派生，零存储、零同步、零失同步
 *
 * A3a delta: panelOpen: boolean → surfaceState: 'collapsed' | 'toolbar' | 'bubble'
 *   三层展开：点猫 collapsed→toolbar，点能力钮 toolbar→bubble，Esc bubble→toolbar→collapsed
 *   listening 条件从 panelOpen+inputFocused → surfaceState==='bubble'+inputFocused
 *
 * 懒接线（INV-9）：
 *   idle 时只有一次 config GET；bubble 展开才 GET /api/concierge/thread（懒创建）
 *   失败 → error 态 + 可手动重试，不自动重试风暴
 */

import type { ConciergeConfig } from '@cat-cafe/shared';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 三层展开状态机（A3a）: collapsed=猫收起 | toolbar=工具栏展开 | bubble=对话气泡 */
export type SurfaceState = 'collapsed' | 'toolbar' | 'bubble';

/**
 * ConciergeInputs: projectBallState 的唯一输入。
 * 这些字段是 store 的实际状态（INV-2: ballState 自身绝不在此）。
 */
export interface ConciergeInputs {
  enabled: boolean;
  muted: boolean;
  /** concierge thread 最新 invocation 状态（chat-types:433 语义） */
  invocationStatus: 'idle' | 'pending' | 'in_progress' | 'error';
  /** 面板内未决确认卡（PR-A3b 前恒 0） */
  pendingConfirmationCount: number;
  /** relay 已投递未回执数（PR-A3b 前恒 0） */
  pendingRelayCount: number;
  /** found 未查看数；bubble 打开并滚到底 → 清零 */
  unseenResultCount: number;
  /** A3a: 三层展开状态（替代 A2 的 panelOpen: boolean） */
  surfaceState: SurfaceState;
  inputFocused: boolean;
}

// ---------------------------------------------------------------------------
// projectBallState — 纯函数（INV-4，导出供测试直接 import）
// ---------------------------------------------------------------------------

/**
 * 球态投影函数。输入 ConciergeInputs，输出球状态或 'hidden'。
 *
 * 优先级全序（高到低）：
 *   hidden(disabled/muted) > error > needs-confirmation > thinking > handoff > listening > found > idle
 *
 * A3a: listening 条件 = surfaceState==='bubble' && inputFocused
 *   （toolbar 展开但未进入气泡时不算 listening，避免误切状态）
 *
 * 无副作用，同 inputs 重复调用输出恒等（INV-4）。
 */
export function projectBallState(i: ConciergeInputs): import('@cat-cafe/shared').ConciergeBallState | 'hidden' {
  if (!i.enabled || i.muted) return 'hidden';
  if (i.invocationStatus === 'error') return 'error';
  if (i.pendingConfirmationCount > 0) return 'needs-confirmation';
  if (i.invocationStatus === 'pending' || i.invocationStatus === 'in_progress') return 'thinking';
  if (i.pendingRelayCount > 0) return 'handoff';
  if (i.surfaceState === 'bubble' && i.inputFocused) return 'listening';
  if (i.unseenResultCount > 0) return 'found';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Store 状态接口
// ---------------------------------------------------------------------------

interface ConciergeStoreState extends ConciergeInputs {
  // Config (loaded from /api/concierge/config)
  displayName: string;
  personaTone: string;
  dutyCatProfileId: string;
  proactivePolicy: 'ambient' | 'quiet-badge';
  skin: 'yarn-ball' | 'ragdoll-v1';

  // Thread
  threadId: string | null;

  // Load state
  configLoaded: boolean;
  configLoading: boolean;
  /** Set true when fetchConfig fails — lets ConciergeHost render with optimistic defaults
   *  instead of staying null forever (P2 R5: no dead state on network error). */
  configFailed: boolean;
  threadIdLoaded: boolean;
  threadIdLoading: boolean;

  // Actions
  /** Lazy-load config once (INV-9: only one GET at idle). No-op if already loading/loaded. */
  fetchConfig: () => Promise<void>;
  /** Lazy-load concierge threadId on first bubble open (INV-9). */
  fetchThreadId: () => Promise<void>;
  /** Toggle muted with optimistic update + PUT /api/concierge/config (INV-8). */
  setMuted: (muted: boolean) => Promise<void>;
  /**
   * A3a: Three-state surface transition.
   * collapsed→toolbar (click cat) | toolbar→bubble (click ability btn) | any→collapsed (Esc/nav)
   * Clearing semantics:
   *   'bubble' → clears unseenResultCount (scroll-to-bottom semantic)
   *   'collapsed'|'toolbar' → clears inputFocused (prevent stale listening state)
   *
   * A3a P2 fix: optional `prompt` pre-fills the concierge input on bubble open.
   * ConciergePanel reads and clears it via clearPendingPrompt().
   */
  setSurfaceState: (state: SurfaceState, prompt?: string) => void;
  /** Clear the pending prompt after ConciergePanel has consumed it. */
  clearPendingPrompt: () => void;
  /** Pre-filled prompt waiting to be consumed by ConciergePanel on next bubble open. */
  pendingPrompt: string | null;
  setInputFocused: (focused: boolean) => void;
  setInvocationStatus: (status: ConciergeInputs['invocationStatus']) => void;
  /** Called before relay dispatch: pendingRelayCount+1 (ball enters handoff). R-review P1 fix. */
  onRelayDispatching: () => void;
  /** Called when relay dispatch HTTP succeeds: pendingRelayCount-1, exit handoff → idle.
   *  Does NOT increment unseenResultCount — found badge waits for the target cat's
   *  actual reply message arriving in the concierge thread (Phase B message detection).
   *  Spec §0: "目标猫回报 = concierge thread 收到普通消息 = found badge". */
  onRelayDispatched: () => void;
  /** Called when target cat's reply message arrives in concierge thread (Phase B).
   *  Decrements pendingRelayCount + increments unseenResultCount → found badge. */
  onRelayReceived: () => void;
  /** Called when relay dispatch fails: pendingRelayCount-1 only (no unseen increment). */
  onRelayFailed: () => void;
  /** Mark all results seen (bubble opened + scrolled to bottom). */
  markResultsSeen: () => void;
  incrementPendingConfirmation: () => void;
  decrementPendingConfirmation: () => void;
  /** Called on concierge_teleport/concierge_go action — collapses surface (INV-7). */
  onNavigationAction: () => void;

  // Ball position (PR-A3b INV-P1~P4)
  /** Ball position in viewport coordinates. null = default bottom-right. */
  ballPosition: { x: number; y: number } | null;
  isDragging: boolean;
  /** Set ball position after drag end. Persists to config (INV-P3: write failure silent). */
  setBallPosition: (pos: { x: number; y: number }) => void;
  /** Set drag state (INV-P1: drag/click disambiguation). */
  setIsDragging: (dragging: boolean) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const DEFAULTS = CONCIERGE_CONFIG_DEFAULTS;

export const useConciergeStore = create<ConciergeStoreState>((set, get) => ({
  // ConciergeInputs
  enabled: true, // optimistic default; fetchConfig will correct if needed
  muted: false,
  invocationStatus: 'idle',
  pendingConfirmationCount: 0,
  pendingRelayCount: 0,
  unseenResultCount: 0,
  surfaceState: 'collapsed',
  inputFocused: false,

  // Ball position (PR-A3b)
  ballPosition: null,
  isDragging: false,

  // Config
  displayName: DEFAULTS.displayName,
  personaTone: DEFAULTS.personaTone,
  dutyCatProfileId: '',
  proactivePolicy: DEFAULTS.proactivePolicy,
  skin: DEFAULTS.skin,

  // Thread
  threadId: null,

  // Pending prompt (A3a P2 fix: toolbar ability buttons pre-fill concierge input)
  pendingPrompt: null,

  // Load state
  configLoaded: false,
  configLoading: false,
  configFailed: false,
  threadIdLoaded: false,
  threadIdLoading: false,

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  fetchConfig: async () => {
    const { configLoaded, configLoading } = get();
    if (configLoaded || configLoading) return; // INV-9: only one GET
    set({ configLoading: true });
    try {
      const res = await apiFetch('/api/concierge/config');
      if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
      // P1-1: backend returns { config: ConciergeConfig } wrapper (concierge.ts:63)
      const { config }: { config: ConciergeConfig } = await res.json();
      set({
        enabled: config.enabled,
        muted: config.muted,
        displayName: config.displayName,
        personaTone: config.personaTone,
        dutyCatProfileId: config.dutyCatProfileId,
        proactivePolicy: config.proactivePolicy,
        skin: config.skin,
        ballPosition: config.ballPosition ?? null,
        configLoaded: true,
        configLoading: false,
      });
    } catch {
      // On failure: mark not loading + set configFailed so ConciergeHost can render
      // with optimistic defaults instead of staying null forever (P2 R5)
      set({ configLoading: false, configFailed: true });
    }
  },

  fetchThreadId: async () => {
    const { threadIdLoaded, threadIdLoading } = get();
    if (threadIdLoaded || threadIdLoading) return; // INV-9: lazy, no repeat
    set({ threadIdLoading: true });
    try {
      // P1 cloud: backend route is POST /api/concierge/thread (concierge.ts:101)
      const res = await apiFetch('/api/concierge/thread', { method: 'POST' });
      if (!res.ok) throw new Error(`thread fetch failed: ${res.status}`);
      const data: { threadId: string } = await res.json();
      set({
        threadId: data.threadId,
        threadIdLoaded: true,
        threadIdLoading: false,
        // P2 cloud: clear error state on successful retry
        invocationStatus: 'idle',
      });
    } catch {
      // INV-9: failure → error state, no auto-retry storm
      set({ invocationStatus: 'error', threadIdLoading: false });
    }
  },

  setMuted: async (muted: boolean) => {
    const prev = get().muted;
    // Optimistic update
    set({ muted });
    try {
      const res = await apiFetch('/api/concierge/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted }),
      });
      if (!res.ok) throw new Error(`muted PUT failed: ${res.status}`);
    } catch {
      // Revert on failure
      set({ muted: prev });
    }
  },

  setSurfaceState: (state: SurfaceState, prompt?: string) => {
    set({ surfaceState: state });
    if (state === 'bubble') {
      // When bubble opens (conceptually scrolled to bottom), clear unseen count
      set({ unseenResultCount: 0 });
      // A3a P2 fix: store pending prompt so ConciergePanel can pre-fill input.
      // Store '' as '' (not null) so 聊聊 (empty prompt) can explicitly clear any existing draft.
      // null = "no pending action"; '' = "open bubble with cleared input"
      if (prompt !== undefined) set({ pendingPrompt: prompt });
    } else {
      // P2-B: clear input focus on partial/full close — prevents stale 'listening' state
      // on reopen when blur handler didn't fire (unmounted component, cross-browser)
      set({ inputFocused: false });
      // Clear pending prompt on close — don't ghost into next bubble open
      set({ pendingPrompt: null });
    }
  },

  clearPendingPrompt: () => set({ pendingPrompt: null }),

  setInputFocused: (focused: boolean) => set({ inputFocused: focused }),

  setInvocationStatus: (status) => set({ invocationStatus: status }),

  // R-review P1 fix: relay must go through handoff before found.
  // Without onRelayDispatching, pendingRelayCount stays 0 and handoff is unreachable.
  onRelayDispatching: () => set((s) => ({ pendingRelayCount: s.pendingRelayCount + 1 })),

  // R-review R3: dispatch success exits handoff → idle (NOT found).
  // Spec §0: found badge waits for target cat's cross_post reply, not dispatch ACK.
  onRelayDispatched: () => set((s) => ({ pendingRelayCount: Math.max(0, s.pendingRelayCount - 1) })),

  // Phase B: called when target cat's reply actually arrives in concierge thread.
  onRelayReceived: () => {
    const { pendingRelayCount, unseenResultCount } = get();
    set({
      pendingRelayCount: Math.max(0, pendingRelayCount - 1),
      unseenResultCount: unseenResultCount + 1,
    });
  },

  onRelayFailed: () => set((s) => ({ pendingRelayCount: Math.max(0, s.pendingRelayCount - 1) })),

  markResultsSeen: () => set({ unseenResultCount: 0 }),

  incrementPendingConfirmation: () => set((s) => ({ pendingConfirmationCount: s.pendingConfirmationCount + 1 })),

  decrementPendingConfirmation: () =>
    set((s) => ({ pendingConfirmationCount: Math.max(0, s.pendingConfirmationCount - 1) })),

  onNavigationAction: () => {
    // INV-7: teleport/go action → collapse surface so user's intent has transferred
    // P2-B: also clear inputFocused — same stale-listening prevention
    set({ surfaceState: 'collapsed', inputFocused: false });
  },

  // -------------------------------------------------------------------------
  // Ball position actions (PR-A3b INV-P1~P4)
  // -------------------------------------------------------------------------

  setBallPosition: async (pos: { x: number; y: number }) => {
    // Optimistic update (INV-P3: persist via config PUT, write failure silent)
    // Note: isDragging is NOT reset here — it stays true so ConciergeBall's onClick
    // can detect "this was a drag, not a click" and suppress the toolbar toggle.
    // ConciergeBall.onClick resets isDragging to false after suppressing.
    //
    // Equality guard: handleDragStop uses flushSync to set position synchronously
    // before calling this function. Skip the redundant set() if position is already
    // current to avoid a wasted re-render (Zustand creates new object → fails ===).
    const current = get().ballPosition;
    if (!current || current.x !== pos.x || current.y !== pos.y) {
      set({ ballPosition: pos });
    }
    try {
      await apiFetch('/api/concierge/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ballPosition: pos }),
      });
    } catch {
      // INV-P3: write failure silent — position stays in local state until next session
    }
  },

  setIsDragging: (dragging: boolean) => set({ isDragging: dragging }),
}));
