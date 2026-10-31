'use client';

import { useEffect, useState } from 'react';
import { showConciergeDesktop, useConciergeDesktopStore } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { CompanionRecoveryAction } from './CompanionRecoveryAction';
import { OwnerPageActionControl } from './OwnerPageActionControl';

/** Presentation inside canonical Chat; creates no socket, history or composer. */
export function useCompanionConversation(threadId: string) {
  const companionThreadId = useConciergeStore((state) => state.threadId);
  const pendingPrompt = useConciergeStore((state) => state.pendingPrompt);
  const clearPendingPrompt = useConciergeStore((state) => state.clearPendingPrompt);
  const desktopAvailable = useConciergeDesktopStore((state) => state.available);
  const desktopLost = useConciergeDesktopStore((state) => state.desktopLost);
  const desktopVisible = useConciergeDesktopStore((state) => state.visible);
  const desktopLossId = useConciergeDesktopStore((state) => state.lossId);
  const current = threadId === companionThreadId;
  const [seed, setSeed] = useState<{ id: string; text: string; threadId: string }>();
  useEffect(() => {
    if (!current) {
      setSeed(undefined);
      return;
    }
    if (pendingPrompt === null) return;
    setSeed({ id: `companion-prompt-${crypto.randomUUID()}`, text: pendingPrompt, threadId });
    clearPendingPrompt();
  }, [current, pendingPrompt, clearPendingPrompt, threadId]);
  return {
    composerSeed: current && seed?.threadId === threadId ? seed : undefined,
    header: current ? (
      <section
        aria-label="伴随对话入口"
        className="mb-3 rounded-xl border border-cafe-divider bg-cafe-surface p-3 text-sm text-cafe-secondary"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>沿用这条伴随对话与已保存的记录。</span>
          <a href="/settings?s=concierge" className="text-cafe-accent underline">
            伴随设置
          </a>
          <a href="/settings?s=plugins" className="text-cafe-accent underline">
            插件状态
          </a>
        </div>
        {desktopLost && (
          <p role="status" className="mt-2">
            桌面猫猫暂时不在线；可继续文字交流，在插件状态中查看恢复信息。
          </p>
        )}
        {(desktopLost || (desktopAvailable && !desktopVisible)) && (
          <CompanionRecoveryAction key={desktopLossId} restore={showConciergeDesktop} />
        )}
        <OwnerPageActionControl />
      </section>
    ) : null,
  };
}
