'use client';

import { useChatStore } from '@/stores/chatStore';
import { assignDocumentRoute } from './ThreadSidebar/thread-navigation';

/**
 * F102 Phase J (AC-J7): Memory quick-link in Hub Group 3 (监控与治理).
 * Links to the dedicated Memory Hub page instead of duplicating IndexStatus here.
 */
export function HubMemoryTab() {
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const openMemory = () => {
    const fromParam = currentThreadId ? `?from=${encodeURIComponent(currentThreadId)}` : '';
    assignDocumentRoute(`/memory${fromParam}`, typeof window !== 'undefined' ? window : undefined);
  };

  return (
    <div className="space-y-3" data-testid="hub-memory-tab">
      <h3 className="text-sm font-semibold text-cafe-black">记忆索引</h3>
      <p className="text-xs text-cafe-secondary">
        记忆索引的完整状态、统计、功能开关和配置参考请前往 Memory Hub 查看。
      </p>
      <button
        type="button"
        onClick={openMemory}
        className="console-button-secondary text-xs"
        data-testid="hub-memory-open"
      >
        打开 Memory Hub →
      </button>
    </div>
  );
}
