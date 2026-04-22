'use client';

import { useChatStore } from '@/stores/chatStore';
import { IndexStatus } from './memory/IndexStatus';
import { assignDocumentRoute } from './ThreadSidebar/thread-navigation';

/**
 * F102 Phase J (AC-J7): Memory status tab in Hub Group 3 (监控与治理).
 * Renders full IndexStatus (health + stats + feature flags + config reference)
 * plus a "打开 Memory Hub" jump button.
 */
export function HubMemoryTab() {
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const openMemory = () => {
    const fromParam = currentThreadId ? `?from=${encodeURIComponent(currentThreadId)}` : '';
    assignDocumentRoute(`/memory${fromParam}`, typeof window !== 'undefined' ? window : undefined);
  };

  return (
    <div className="space-y-4" data-testid="hub-memory-tab">
      <h3 className="text-sm font-semibold text-cafe-black">记忆索引状态</h3>
      <IndexStatus />
      <button
        type="button"
        onClick={openMemory}
        className="inline-flex items-center gap-2 rounded-lg border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-700 transition-colors hover:bg-purple-100"
        data-testid="hub-memory-open"
      >
        打开 Memory Hub
      </button>
    </div>
  );
}
