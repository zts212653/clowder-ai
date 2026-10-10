'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CatData, useCatData } from '@/hooks/useCatData';
import type { ChatUserScrollGesture } from '@/hooks/useChatHistory';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveMessageSender } from '@/lib/resolve-sender';
import type { ChatMessage as ChatMessageData } from '@/stores/chatStore';
import type { CoCreatorConfig } from './config-viewer-types';
import { messageRendersNothing } from './message-render-visibility';

/** Maximum dots rendered on the track — prevents clutter in long conversations */
const MAX_DOTS = 18;

type CatLookup = (id: string) => CatData | undefined;

function wheelDeltaPx(event: WheelEvent, container: HTMLElement): number {
  if (event.deltaMode === 2) return event.deltaY * container.clientHeight;
  if (event.deltaMode === 1) return event.deltaY * (Number.parseFloat(getComputedStyle(container).lineHeight) || 16);
  return event.deltaY;
}

function getSenderLabel(msg: ChatMessageData, resolveCat: CatLookup, coCreator: CoCreatorConfig): string {
  return resolveMessageSender(msg, resolveCat, coCreator).label;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function truncateContent(content: string, maxLen: number): string {
  return content.length <= maxLen ? content : `${content.slice(0, maxLen)}…`;
}

export function messageNavigatorPreviewText(
  message: ChatMessageData,
  messages: readonly ChatMessageData[],
): string | null {
  void messages;
  return truncateContent(message.content, 40);
}

interface MessageNavigatorProps {
  messages: ChatMessageData[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  onJumpToMessage: (messageId: string) => boolean;
  beginUserScroll: () => ChatUserScrollGesture | null;
}

export function MessageNavigator({
  messages,
  scrollContainerRef,
  onJumpToMessage,
  beginUserScroll,
}: MessageNavigatorProps) {
  const { getCatById } = useCatData();
  const coCreator = useCoCreatorConfig();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const resolveCat = useCallback((catId: string) => getCatById(catId), [getCatById]);

  const getSenderName = useCallback(
    (msg: ChatMessageData) => getSenderLabel(msg, resolveCat, coCreator),
    [coCreator, resolveCat],
  );

  // Navigate the same visible message surfaces as the timeline, including external inputs.
  const navItems = useMemo(
    () =>
      messages.filter(
        (m) =>
          (m.type === 'user' || m.type === 'assistant' || m.type === 'connector') &&
          !messageRendersNothing(m, messages),
      ),
    [messages],
  );

  // Sample at fixed intervals when too many messages
  const sampledItems = useMemo(() => {
    if (navItems.length <= MAX_DOTS) {
      return navItems.map((msg, i) => ({ msg, sourceIdx: i }));
    }
    const step = (navItems.length - 1) / (MAX_DOTS - 1);
    return Array.from({ length: MAX_DOTS }, (_, i) => {
      const idx = Math.round(i * step);
      return { msg: navItems[idx], sourceIdx: idx };
    });
  }, [navItems]);

  // Click on track background → scroll proportionally
  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      const container = scrollContainerRef.current;
      if (!track || !container) return;
      // Ignore clicks on dots — closest() handles future child elements too (P3 fix)
      if ((e.target as HTMLElement).closest('button')) return;
      const rect = track.getBoundingClientRect();
      if (rect.height <= 0) return;
      const ratio = (e.clientY - rect.top) / rect.height;
      const gesture = beginUserScroll();
      gesture?.scrollTo(ratio * (container.scrollHeight - container.clientHeight));
      gesture?.end();
    },
    [scrollContainerRef, beginUserScroll],
  );

  const visible = navItems.length >= 3;
  useEffect(() => {
    if (!visible) return;
    const track = trackRef.current;
    if (!track) return;
    const wheel = (event: WheelEvent) => {
      const container = scrollContainerRef.current;
      if (!container || event.ctrlKey || event.deltaY === 0) return;
      const gesture = beginUserScroll();
      if (!gesture) return;
      if (gesture.scrollTo(container.scrollTop + wheelDeltaPx(event, container))) event.preventDefault();
      gesture.end();
    };
    // React delegates wheel passively; this control must prevent scrolling the page.
    track.addEventListener('wheel', wheel, { passive: false });
    return () => track.removeEventListener('wheel', wheel);
  }, [beginUserScroll, scrollContainerRef, visible]);

  if (!visible) return null;

  return (
    <div data-message-navigator className="absolute right-0.5 top-2 bottom-2 w-5 z-10">
      <div ref={trackRef} className="relative h-full cursor-pointer" onClick={handleTrackClick}>
        {/* Track rail — thin connecting line between dots */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--console-border-soft)] -translate-x-1/2" />

        {/* Sampled dots */}
        {sampledItems.map(({ msg, sourceIdx }, idx) => {
          const top = sampledItems.length <= 1 ? 50 : (idx / (sampledItems.length - 1)) * 100;
          const sender = resolveMessageSender(msg, resolveCat, coCreator);
          const style = { backgroundColor: sender.color };

          return (
            <button
              type="button"
              key={`${msg.id}-${sourceIdx}`}
              className={`absolute w-2 h-2 rounded-full -translate-x-1/2 -translate-y-1/2 transition-all duration-150 hover:scale-[2]`}
              style={{ top: `${top}%`, left: '50%', ...style }}
              onClick={() => onJumpToMessage(msg.id)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              aria-label={`跳转到 ${getSenderName(msg)} 的消息`}
            />
          );
        })}

        {/* Tooltip */}
        {hoveredIdx !== null && sampledItems[hoveredIdx] && (
          <NavTooltip
            message={sampledItems[hoveredIdx].msg}
            messages={messages}
            topPercent={sampledItems.length <= 1 ? 50 : (hoveredIdx / (sampledItems.length - 1)) * 100}
            ownerName={coCreator.name}
          />
        )}
      </div>
    </div>
  );
}

function NavTooltip({
  message,
  messages,
  topPercent,
  ownerName,
}: {
  message: ChatMessageData;
  messages: readonly ChatMessageData[];
  topPercent: number;
  ownerName: string;
}) {
  const { getCatById } = useCatData();
  const resolveCat = useCallback((catId: string) => getCatById(catId), [getCatById]);

  const coCreator = useCoCreatorConfig();
  const senderName = getSenderLabel(message, resolveCat, { ...coCreator, name: ownerName });
  const previewText = messageNavigatorPreviewText(message, messages);

  return (
    <div
      className="absolute right-full mr-2 -translate-y-1/2 bg-cafe-surface-sunken text-cafe text-xs rounded-lg px-2.5 py-1.5 max-w-[200px] pointer-events-none whitespace-nowrap z-50"
      style={{ top: `${topPercent}%` }}
    >
      <div className="font-medium">
        {senderName} · {formatTime(message.timestamp)}
      </div>
      {previewText ? <div className="text-cafe-muted truncate mt-0.5">{previewText}</div> : null}
    </div>
  );
}
