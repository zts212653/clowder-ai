/**
 * F155: Guide Engine Store (v2 — tag-based engine)
 *
 * OrchestrationStep schema matches backend flow definitions.
 * Engine auto-advances on user interaction — no manual next/prev/skip.
 */
import { create } from 'zustand';

/* ── Orchestration Types (shared schema with backend) ── */

export interface OrchestrationStep {
  id: string;
  /** data-guide-id value on the target element */
  target: string;
  /** Guide text shown to user (from flow definition, NOT frontend) */
  tips: string;
  /** How to auto-advance: click target / target becomes visible / input filled / manual confirm */
  advance: 'click' | 'visible' | 'input' | 'confirm';
  page?: string;
  timeoutSec?: number;
}

export interface OrchestrationFlow {
  id: string;
  name: string;
  description?: string;
  steps: OrchestrationStep[];
}

/* ── Session State ── */

export type GuidePhase = 'locating' | 'active' | 'complete';

export interface GuideSession {
  flow: OrchestrationFlow;
  sessionId: string;
  /** Thread where this guide was triggered (for completion callback) */
  threadId: string | null;
  currentStepIndex: number;
  phase: GuidePhase;
  startedAt: number;
}

/** B-5: Server event shape for Socket.io → Zustand reducer. */
export interface GuideServerEvent {
  action: 'start' | 'control_next' | 'control_skip' | 'control_exit' | 'complete';
  guideId: string;
  threadId: string;
}

interface GuideState {
  session: GuideSession | null;
  /** True once the backend has acknowledged guide completion */
  completionPersisted: boolean;
  /** True when completion callback failed permanently — overlay shows error instead of dismiss */
  completionFailed: boolean;
  /** Pending flow to start — set by reduceServerEvent('start'), consumed by useGuideEngine */
  pendingStart: { guideId: string; threadId: string } | null;
  startGuide: (flow: OrchestrationFlow, threadId?: string) => void;
  advanceStep: () => void;
  exitGuide: () => void;
  setPhase: (phase: GuidePhase) => void;
  markCompletionPersisted: (sessionId: string) => void;
  markCompletionFailed: (sessionId: string) => void;
  /** B-5: Central reducer for all Socket.io guide events. */
  reduceServerEvent: (event: GuideServerEvent) => void;
  clearPendingStart: () => void;
}

let sessionCounter = 0;

export const useGuideStore = create<GuideState>((set, get) => ({
  session: null,
  completionPersisted: false,
  completionFailed: false,
  pendingStart: null,

  startGuide: (flow, threadId) => {
    sessionCounter += 1;
    set({
      completionPersisted: false,
      completionFailed: false,
      session: {
        flow,
        sessionId: `guide-${flow.id}-${sessionCounter}`,
        threadId: threadId ?? null,
        currentStepIndex: 0,
        phase: 'locating',
        startedAt: Date.now(),
      },
    });
  },

  advanceStep: () => {
    const { session } = get();
    if (!session) return;
    const nextIndex = session.currentStepIndex + 1;
    if (nextIndex >= session.flow.steps.length) {
      set({ session: { ...session, currentStepIndex: nextIndex, phase: 'complete' } });
      return;
    }
    set({
      session: { ...session, currentStepIndex: nextIndex, phase: 'locating' },
    });
  },

  exitGuide: () => set({ session: null, completionPersisted: false, completionFailed: false }),

  markCompletionPersisted: (sessionId) =>
    set((state) => {
      if (!state.session) return state;
      if (state.session.sessionId !== sessionId || state.session.phase !== 'complete') {
        return state;
      }
      return { completionPersisted: true };
    }),

  markCompletionFailed: (sessionId) =>
    set((state) => {
      if (!state.session) return state;
      if (state.session.sessionId !== sessionId || state.session.phase !== 'complete') {
        return state;
      }
      return { completionFailed: true };
    }),

  setPhase: (phase) => {
    const { session } = get();
    if (!session || session.phase === phase) return;
    if (session.currentStepIndex >= session.flow.steps.length) {
      if (session.phase !== 'complete') {
        set({ session: { ...session, phase: 'complete' } });
      }
      return;
    }
    if (session.phase === 'complete') return;
    set({ session: { ...session, phase } });
  },

  reduceServerEvent: (event) => {
    const { session, advanceStep, exitGuide, setPhase } = get();

    const sessionMatch = session && session.flow.id === event.guideId && session.threadId === event.threadId;

    switch (event.action) {
      case 'start':
        set({ pendingStart: { guideId: event.guideId, threadId: event.threadId } });
        break;
      case 'control_next':
      case 'control_skip':
        if (sessionMatch) advanceStep();
        break;
      case 'control_exit':
        if (sessionMatch) exitGuide();
        if (get().pendingStart?.guideId === event.guideId && get().pendingStart?.threadId === event.threadId) {
          set({ pendingStart: null });
        }
        break;
      case 'complete':
        if (sessionMatch) setPhase('complete');
        break;
    }
  },

  clearPendingStart: () => set({ pendingStart: null }),
}));
