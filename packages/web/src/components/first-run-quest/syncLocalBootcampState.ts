import type { Thread } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';

export function syncLocalBootcampState(threadId: string, bootcampState: Thread['bootcampState']) {
  useChatStore.setState((state) => {
    const exists = state.threads.some((t) => t.id === threadId);
    if (exists) {
      return { threads: state.threads.map((t) => (t.id === threadId ? { ...t, bootcampState } : t)) };
    }
    // Thread not yet in store (sidebar hasn't loaded) — inject a minimal stub
    // so bootcamp-phase-dependent effects can fire before sidebar completes.
    return {
      threads: [
        ...state.threads,
        { id: threadId, title: '', createdAt: Date.now(), lastActiveAt: Date.now(), bootcampState } as Thread,
      ],
    };
  });
}
