/**
 * F173 Phase C — PR-C Task 10 + 12
 *
 * `reconcileThreadWithServer` must respect F173 KD-2 mirror invariant:
 *   for any thread T, server-side reconcile writes that touch liveness fields
 *   (activeInvocations / hasActiveInvocation / catStatuses / targetCats /
 *   isLoading / intentMode / message.isStreaming) MUST go through thread-scoped
 *   writers so flat state and threadStates[T] stay in lockstep.
 *
 * Before Task 10 the active-thread branch called flat-only writers
 * (addActiveInvocation / setLoading / setIntentMode / clearCatStatuses /
 *  setStreaming) — these did NOT mirror to threadStates[currentThreadId],
 * which is exactly the structural drift F173 PR-A/B closed for the read side.
 * Reconcile was the last writer that still split active-vs-background paths.
 *
 * 5 scenarios per Phase C plan (F5 / thread switch / reconnect / cross-post /
 * cancel-during-stream): F5 is covered by hydrateThread fixtures (PR #1413),
 * thread-switch by useAgentMessages-thread-switch fixture (PR #1391).
 * The three NEW scenarios live here:
 *   - reconnect: server has slots → re-hydrate writes flat AND threadStates[active]
 *   - cross-post: server has slots → background reconcile writes only threadStates[bg]
 *   - cancel-during-stream: server no slots → clears flat AND threadStates[active]
 *
 * Plus 2 sanity fixtures completing the AC-C6/C7 picture:
 *   - server no slots clears background only (cross-post inverse)
 *   - cancel-during-stream also clears in-flight isStreaming flags
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THREAD_STATE, useChatStore } from '../../stores/chatStore';
import { reconcileThreadWithServer } from '../useSocket';

const ACTIVE_TID = 'thread-active';
const BG_TID = 'thread-background';

function resetStore() {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: false,
    hasDraft: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    currentGame: null,
    threadStates: {},
    viewMode: 'single',
    splitPaneThreadIds: [],
    splitPaneTargetId: null,
    currentThreadId: ACTIVE_TID,
    currentProjectPath: 'default',
    threads: [],
    isLoadingThreads: false,
  });
}

function mockApiFetchOnce(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Mock-Url': url },
    });
  });
}

describe('reconcileThreadWithServer — F173 PR-C Task 10 mirror invariant', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reconnect: server has slots, ACTIVE thread', () => {
    it('re-hydrate writes flat AND mirrors threadStates[active] (mirror invariant)', async () => {
      mockApiFetchOnce({ activeInvocations: [{ catId: 'opus', startedAt: 1000 }] });

      await reconcileThreadWithServer(ACTIVE_TID, () => false, 'TestReconnect');

      const s = useChatStore.getState();
      // flat (compat) — writer auto-mirrors when threadId === currentThreadId
      expect(s.hasActiveInvocation).toBe(true);
      const flatInvIds = Object.keys(s.activeInvocations);
      expect(flatInvIds.length).toBe(1);
      expect(s.activeInvocations[flatInvIds[0]]?.catId).toBe('opus');
      expect(s.targetCats).toContain('opus');
      expect(s.catStatuses.opus).toBe('streaming');
      // mirror — threadStates[active] must reflect same payload (RED before Task 10)
      const ts = s.threadStates[ACTIVE_TID];
      expect(ts).toBeDefined();
      expect(ts?.hasActiveInvocation).toBe(true);
      const tsInvIds = Object.keys(ts?.activeInvocations ?? {});
      expect(tsInvIds.length).toBe(1);
      expect(ts?.activeInvocations[tsInvIds[0]]?.catId).toBe('opus');
      expect(ts?.targetCats).toContain('opus');
      expect(ts?.catStatuses.opus).toBe('streaming');
    });
  });

  describe('cross-post: server has slots, BACKGROUND thread', () => {
    it('writes only threadStates[bg], flat untouched', async () => {
      mockApiFetchOnce({ activeInvocations: [{ catId: 'gpt52', startedAt: 2000 }] });

      await reconcileThreadWithServer(BG_TID, () => false, 'TestCrossPost');

      const s = useChatStore.getState();
      // flat untouched — never the BG thread's truth
      expect(s.hasActiveInvocation).toBe(false);
      expect(Object.keys(s.activeInvocations).length).toBe(0);
      expect(s.targetCats.length).toBe(0);
      expect(s.catStatuses).toEqual({});
      // threadStates[bg] reflects the server slot
      const ts = s.threadStates[BG_TID];
      expect(ts).toBeDefined();
      expect(ts?.hasActiveInvocation).toBe(true);
      const bgInvIds = Object.keys(ts?.activeInvocations ?? {});
      expect(bgInvIds.length).toBe(1);
      expect(ts?.activeInvocations[bgInvIds[0]]?.catId).toBe('gpt52');
      expect(ts?.targetCats).toContain('gpt52');
      expect(ts?.catStatuses.gpt52).toBe('streaming');
    });
  });

  describe('cancel-during-stream: server NO slots, ACTIVE thread had stale state', () => {
    it('clears flat AND mirrors clear to threadStates[active]', async () => {
      // Seed active thread with stale liveness as if a cancel just happened on
      // server but the local UI still thinks it's running.
      useChatStore.setState({
        hasActiveInvocation: true,
        isLoading: true,
        intentMode: 'execute',
        targetCats: ['opus'],
        catStatuses: { opus: 'streaming' },
        activeInvocations: { 'inv-stale': { catId: 'opus', mode: 'execute', startedAt: 100 } },
        messages: [
          { id: 'asst-1', type: 'assistant', catId: 'opus', content: 'partial', timestamp: 200, isStreaming: true },
        ],
      });
      mockApiFetchOnce({ activeInvocations: [] });

      await reconcileThreadWithServer(ACTIVE_TID, () => false, 'TestCancel');

      const s = useChatStore.getState();
      // flat cleared
      expect(s.hasActiveInvocation).toBe(false);
      expect(s.isLoading).toBe(false);
      expect(s.intentMode).toBeNull();
      expect(Object.keys(s.activeInvocations).length).toBe(0);
      expect(s.catStatuses).toEqual({});
      expect(s.messages.find((m) => m.id === 'asst-1')?.isStreaming).toBeFalsy();
      // mirror — threadStates[active] should match cleared flat (RED before Task 10)
      const ts = s.threadStates[ACTIVE_TID];
      expect(ts).toBeDefined();
      expect(ts?.hasActiveInvocation).toBe(false);
      expect(ts?.isLoading).toBe(false);
      expect(ts?.intentMode).toBeNull();
      expect(Object.keys(ts?.activeInvocations ?? {}).length).toBe(0);
      expect(ts?.catStatuses).toEqual({});
      expect(ts?.messages.find((m) => m.id === 'asst-1')?.isStreaming).toBeFalsy();
    });
  });

  describe('cross-post inverse: server NO slots, BACKGROUND thread had stale state', () => {
    it('clears threadStates[bg] only, flat untouched', async () => {
      useChatStore.setState({
        threadStates: {
          [BG_TID]: {
            ...DEFAULT_THREAD_STATE,
            messages: [
              {
                id: 'bg-asst-1',
                type: 'assistant',
                catId: 'gpt52',
                content: 'partial',
                timestamp: 1,
                isStreaming: true,
              },
            ],
            isLoading: true,
            hasActiveInvocation: true,
            activeInvocations: { 'bg-stale-inv': { catId: 'gpt52', mode: 'execute', startedAt: 1 } },
            targetCats: ['gpt52'],
            catStatuses: { gpt52: 'streaming' },
          },
        },
      });
      mockApiFetchOnce({ activeInvocations: [] });

      await reconcileThreadWithServer(BG_TID, () => false, 'TestBgCancel');

      const s = useChatStore.getState();
      // flat untouched
      expect(s.hasActiveInvocation).toBe(false);
      expect(s.isLoading).toBe(false);
      // threadStates[bg] cleared
      const ts = s.threadStates[BG_TID];
      expect(ts?.hasActiveInvocation).toBe(false);
      expect(ts?.isLoading).toBe(false);
      expect(ts?.messages.find((m) => m.id === 'bg-asst-1')?.isStreaming).toBeFalsy();
    });
  });
});
