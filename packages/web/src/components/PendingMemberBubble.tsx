'use client';

import type { CapabilityTipContext } from '@cat-cafe/shared';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { CatStatusType } from '@/stores/chatStore';
import { CapabilityTipStrip } from './CapabilityTipStrip';
import { CatAvatar } from './CatAvatar';
import { DEFAULT_STREAMING_TIP_CONTEXTS, isStreamingTipSuppressedByStatus } from './capability-tip-placement';
import { MessageBubble } from './MessageBubble';

interface PendingMemberBubbleProps {
  catId: string;
  invocationId: string;
  /** Liveness status for stall suppression — hide tips when cat is stalled (AC-B2 red line). */
  catStatus?: CatStatusType;
  /** Tip contexts from intentMode — review mode gets review tips instead of generic thinking tips. */
  tipContexts?: readonly CapabilityTipContext[];
  /** Only one pending bubble per thread should show tips (dedup — cloud review P2). */
  showCapabilityTip?: boolean;
}

/**
 * Minimal dots fallback for dedup bubbles (showCapabilityTip=false) and
 * stall-suppressed states where the tip strip is hidden (AC-B2).
 */
function PendingDots() {
  return (
    <div className="flex items-center gap-1 py-2 text-cafe-fg-muted" role="status">
      <span className="sr-only">处理中</span>
      <span className="inline-flex gap-0.5" aria-hidden="true">
        <span className="animate-bounce text-sm" style={{ animationDelay: '0ms' }}>
          ·
        </span>
        <span className="animate-bounce text-sm" style={{ animationDelay: '150ms' }}>
          ·
        </span>
        <span className="animate-bounce text-sm" style={{ animationDelay: '300ms' }}>
          ·
        </span>
      </span>
    </div>
  );
}

/**
 * #936: Show a member-level pending bubble with avatar before any stream
 * content arrives.
 *
 * F244 operator dogfood Round 4: the tip strip IS the thinking indicator —
 * a unified bubble with breathing animation. No separate dots when tips
 * are active. Dedup bubbles (showCapabilityTip=false) and stall states
 * fall back to minimal dots.
 */
export function PendingMemberBubble({
  catId,
  invocationId,
  catStatus,
  tipContexts,
  showCapabilityTip = false,
}: PendingMemberBubbleProps) {
  const { getCatById } = useCatData();
  const catData = getCatById(catId);
  const catName = catData ? formatCatName(catData) : catId;

  const tipEnabled = showCapabilityTip && !isStreamingTipSuppressedByStatus(catStatus);

  return (
    <MessageBubble
      messageId={`pending-${invocationId}`}
      avatar={<CatAvatar catId={catId} size={32} status="streaming" />}
      header={
        <span className="text-xs font-semibold" style={{ color: catData?.color?.primary, opacity: 0.8 }}>
          {catName}
        </span>
      }
      wrapperClassName="group cat-persona-derived"
    >
      {tipEnabled ? (
        <CapabilityTipStrip
          surface="pending_bubble"
          contexts={tipContexts ?? DEFAULT_STREAMING_TIP_CONTEXTS}
          audience="cvo"
          enabled
          firstDelayMs={0}
        />
      ) : (
        <PendingDots />
      )}
    </MessageBubble>
  );
}
