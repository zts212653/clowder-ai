'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { type CatData, formatCatName, useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { catColorVar } from '@/lib/cat-slug';
import { CAT_COLORS } from '@/lib/color-defaults';
import type { ChatMessage as ChatMessageData } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';

/** Maximum dots rendered on the track — prevents clutter in long conversations */
const MAX_DOTS = 18;

type CatLookup = (id: string) => CatData | undefined;

// Some variants use non-hyphen catIds (e.g. gpt52/sonnet/spark/gemini25 in the runtime cat config).
// During the brief pre-/api/cats state, the cat list may be empty, so we map
// variant ids to a base color only. Identity text keeps the raw-id fallback
// until the runtime roster can resolve the exact member.
const VARIANT_BASE_FALLBACK: Record<string, string> = {
  gpt52: 'codex',
  spark: 'codex',
  sonnet: 'opus',
  gemini25: 'gemini',
};

const FALLBACK_CAT_COLORS: Record<string, string> = {
  opus: CAT_COLORS.opus.primary,
  codex: CAT_COLORS.codex.primary,
  gemini: CAT_COLORS.gemini.primary,
  kimi: CAT_COLORS.kimi.primary,
};

function resolveFallbackCatColor(catId: string): string | undefined {
  const normalizedId = catId.toLowerCase();
  const direct = FALLBACK_CAT_COLORS[normalizedId];
  if (direct) return direct;

  const base = normalizedId.split('-')[0];
  if (base && base !== normalizedId && FALLBACK_CAT_COLORS[base]) return FALLBACK_CAT_COLORS[base];

  const mappedBase = VARIANT_BASE_FALLBACK[normalizedId];
  if (mappedBase && FALLBACK_CAT_COLORS[mappedBase]) return FALLBACK_CAT_COLORS[mappedBase];

  return undefined;
}

function resolveCatById(getCatById: CatLookup, catId: string): CatData | undefined {
  return getCatById(catId.toLowerCase());
}

function getSenderLabel(
  msg: ChatMessageData,
  resolveCat: (catId: string) => CatData | undefined,
  ownerName: string,
): string {
  const catId = msg.catId;
  const isOwner = msg.type === 'user' && !catId;
  if (isOwner) return ownerName;

  const isAssistant = msg.type === 'assistant' || (msg.type === 'user' && !!catId);
  if (!isAssistant) return '系统';
  if (!catId) return '系统';
  const cat = resolveCat(catId);
  return cat ? formatCatName(cat) : catId;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function truncateContent(content: string, maxLen: number): string {
  return content.length <= maxLen ? content : `${content.slice(0, maxLen)}…`;
}

interface MessageNavigatorProps {
  messages: ChatMessageData[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

export function MessageNavigator({ messages, scrollContainerRef }: MessageNavigatorProps) {
  const { getCatById } = useCatData();
  const coCreator = useCoCreatorConfig();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const resolveCat = useCallback((catId: string) => resolveCatById(getCatById, catId), [getCatById]);

  const getSenderName = useCallback(
    (msg: ChatMessageData) => getSenderLabel(msg, resolveCat, coCreator.name),
    [coCreator.name, resolveCat],
  );

  // Filter to user + assistant only
  const navItems = useMemo(() => messages.filter((m) => m.type === 'user' || m.type === 'assistant'), [messages]);

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
      const ratio = (e.clientY - rect.top) / rect.height;
      container.scrollTo({
        top: ratio * (container.scrollHeight - container.clientHeight),
        behavior: 'smooth',
      });
    },
    [scrollContainerRef],
  );

  if (navItems.length < 3) return null;

  return (
    <div className="absolute right-0.5 top-2 bottom-2 w-5 z-10">
      <div ref={trackRef} className="relative h-full cursor-pointer" onClick={handleTrackClick}>
        {/* Track rail — thin connecting line between dots */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--console-border-soft)] -translate-x-1/2" />

        {/* Sampled dots */}
        {sampledItems.map(({ msg, sourceIdx }, idx) => {
          const top = sampledItems.length <= 1 ? 50 : (idx / (sampledItems.length - 1)) * 100;
          const isOwner = msg.type === 'user' && !msg.catId;
          const isAssistant = msg.type === 'assistant' || (msg.type === 'user' && !!msg.catId);
          const cat = isAssistant && msg.catId ? resolveCat(msg.catId) : undefined;
          const fallbackColor = isAssistant && msg.catId ? resolveFallbackCatColor(msg.catId) : undefined;
          const className = isOwner ? 'bg-cafe-accent' : cat || fallbackColor ? '' : 'bg-gray-400';
          const style = isOwner
            ? undefined
            : cat
              ? { backgroundColor: catColorVar(cat.id, 'primary') }
              : fallbackColor
                ? { backgroundColor: fallbackColor }
                : undefined;

          return (
            <button
              key={`${msg.id}-${sourceIdx}`}
              className={`absolute w-2 h-2 rounded-full -translate-x-1/2 -translate-y-1/2 transition-all duration-150 hover:scale-[2] ${className}`}
              style={{ top: `${top}%`, left: '50%', ...(style ?? {}) }}
              onClick={() => scrollToMessage(msg.id)}
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
  topPercent,
  ownerName,
}: {
  message: ChatMessageData;
  topPercent: number;
  ownerName: string;
}) {
  const { getCatById } = useCatData();
  const resolveCat = useCallback((catId: string) => resolveCatById(getCatById, catId), [getCatById]);

  const senderName = useMemo(() => {
    return getSenderLabel(message, resolveCat, ownerName);
  }, [message, ownerName, resolveCat]);

  return (
    <div
      className="absolute right-full mr-2 -translate-y-1/2 bg-cafe-surface-sunken text-cafe text-xs rounded-lg px-2.5 py-1.5 max-w-[200px] pointer-events-none whitespace-nowrap z-50"
      style={{ top: `${topPercent}%` }}
    >
      <div className="font-medium">
        {senderName} · {formatTime(message.timestamp)}
      </div>
      <div className="text-cafe-muted truncate mt-0.5">{truncateContent(message.content, 40)}</div>
    </div>
  );
}
