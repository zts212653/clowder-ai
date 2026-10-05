'use client';

import { useCatData } from '@/hooks/useCatData';
import { resolveCompanionPartnerName } from '@/lib/companion-partner-name';
import { dismissConciergeDesktopLossNotice, showConciergeDesktop } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { CompanionRecoveryAction } from './CompanionRecoveryAction';

/** Desktop loss changes the body surface, not the installed Companion or chat history. */
export function ConciergeDesktopFallbackNotice() {
  const dutyCatProfileId = useConciergeStore((state) => state.dutyCatProfileId);
  const { getCatById } = useCatData();
  const partnerName = dutyCatProfileId ? resolveCompanionPartnerName(dutyCatProfileId, getCatById) : undefined;

  return (
    <output
      aria-live="polite"
      data-testid="concierge-desktop-fallback"
      className="fixed bottom-28 right-4 z-[35] w-[calc(100vw-2rem)] max-w-xs rounded-xl border border-cafe-divider bg-cafe-surface px-3 py-2 text-xs text-cafe-secondary shadow-lg"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          独立桌面猫猫球暂时不在线；这里是网页备用入口，已安装的插件和聊天记录没有被替换。
        </span>
        <button
          type="button"
          aria-label="关闭桌面失联提示"
          onClick={dismissConciergeDesktopLossNotice}
          className="shrink-0 rounded px-1 text-cafe-muted hover:text-cafe focus-visible:outline focus-visible:outline-2 focus-visible:outline-cafe-accent"
        >
          关闭
        </button>
      </div>{' '}
      <a className="font-medium text-cafe-accent underline" href="/settings?s=plugins">
        查看插件状态
      </a>
      <CompanionRecoveryAction partnerName={partnerName} restore={showConciergeDesktop} />
    </output>
  );
}
