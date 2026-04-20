'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CatData, formatCatName, useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageData } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';

/** Maximum dots rendered on the track — prevents clutter in long conversations */
const MAX_DOTS = 18;

type CatLookup = (id: string) => CatData | undefined;

// Some variants use non-hyphen catIds (e.g. gpt52/sonnet/spark/gemini25 in cat-config.json).
// During the brief pre-/api/cats state, we only have 3 base cats in fallback CAT_CONFIGS,
// so we map these variant ids to a base cat for color/name consistency.
const VARIANT_BASE_FALLBACK: Record<string, string> = {
  gpt52: 'codex',
  spark: 'codex',
  sonnet: 'opus',
  gemini25: 'gemini',
  'dare-agent': 'dare',
};

const FALLBACK_CAT_META: Record<string, { label: string; color: string }> = {
  opus: { label: '布偶猫', color: '#9B7EBD' },
  codex: { label: '缅因猫', color: '#5B8C5A' },
  gemini: { label: '暹罗猫', color: '#5B9BD5' },
  kimi: { label: '梵花猫', color: '#4B5563' },
  dare: { label: '狸花猫', color: '#D4A76A' },
};

function resolveFallbackCatMeta(catId: string): { baseId: string; label: string; color: string } | undefined {
  const normalizedId = catId.toLowerCase();
  const direct = FALLBACK_CAT_META[normalizedId];
  if (direct) return { baseId: normalizedId, ...direct };

  const base = normalizedId.split('-')[0];
  if (base && base !== normalizedId && FALLBACK_CAT_META[base]) {
    return { baseId: base, ...FALLBACK_CAT_META[base] };
  }

  const mappedBase = VARIANT_BASE_FALLBACK[normalizedId];
  if (mappedBase && FALLBACK_CAT_META[mappedBase]) {
    return { baseId: mappedBase, ...FALLBACK_CAT_META[mappedBase] };
  }

  return undefined;
}

function resolveCatById(getCatById: CatLookup, catId: string): CatData | undefined {
  const normalizedId = catId.toLowerCase();
  const direct = getCatById(normalizedId);
  if (direct) return direct;
  // F32-b P4: tolerate multi-variant ids (e.g. opus-45) even before /api/cats loads
  const base = normalizedId.split('-')[0];
  if (base && base !== normalizedId) return getCatById(base);
  const mappedBase = VARIANT_BASE_FALLBACK[normalizedId];
  if (mappedBase) return getCatById(mappedBase);
  return undefined;
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
  if (!cat) {
    const fallback = resolveFallbackCatMeta(catId);
    if (!fallback) return catId;
    return fallback.baseId === catId.toLowerCase() ? fallback.label : `${fallback.label}（${catId}）`;
  }
  const baseName = formatCatName(cat);
  return cat.id === catId ? baseName : `${cat.displayName}（${catId}）`;
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
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
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

  // Sync viewport indicator with scroll position
  const updateViewport = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      setViewport({ top: 0, height: 1 });
      return;
    }
    setViewport({
      top: scrollTop / scrollHeight,
      height: clientHeight / scrollHeight,
    });
  }, [scrollContainerRef]);

  // Re-bind on navItems change so ref.current is re-read if container remounts (P3 fix)
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    updateViewport();
    el.addEventListener('scroll', updateViewport, { passive: true });
    return () => el.removeEventListener('scroll', updateViewport);
  }, [scrollContainerRef, updateViewport]);

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
        {/* Track rail */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-200 -translate-x-1/2" />

        {/* Viewport indicator (scrollbar thumb) — P2 fix: clamp to prevent overflow */}
        {(() => {
          const thumbH = Math.max(viewport.height * 100, 5);
          const thumbTop = Math.min(viewport.top * 100, 100 - thumbH);
          return (
            <div
              className="absolute left-1/2 -translate-x-1/2 w-2.5 rounded-full bg-gray-300/50 transition-all duration-100 pointer-events-none"
              style={{ top: `${thumbTop}%`, height: `${thumbH}%` }}
            />
          );
        })()}

        {/* Sampled dots */}
        {sampledItems.map(({ msg, sourceIdx }, idx) => {
          const top = sampledItems.length <= 1 ? 50 : (idx / (sampledItems.length - 1)) * 100;
          const isOwner = msg.type === 'user' && !msg.catId;
          const isAssistant = msg.type === 'assistant' || (msg.type === 'user' && !!msg.catId);
          const cat = isAssistant && msg.catId ? resolveCat(msg.catId) : undefined;
          const fallback = isAssistant && msg.catId ? resolveFallbackCatMeta(msg.catId) : undefined;
          const className = isOwner ? 'bg-cocreator-primary' : cat || fallback ? '' : 'bg-gray-400';
          const style = isOwner
            ? undefined
            : cat
              ? { backgroundColor: cat.color.primary }
              : fallback
                ? { backgroundColor: fallback.color }
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
      className="absolute right-full mr-2 -translate-y-1/2 bg-gray-900/90 text-white text-xs rounded-lg px-2.5 py-1.5 max-w-[200px] pointer-events-none whitespace-nowrap z-50"
      style={{ top: `${topPercent}%` }}
    >
      <div className="font-medium">
        {senderName} · {formatTime(message.timestamp)}
      </div>
      <div className="text-cafe-muted truncate mt-0.5">{truncateContent(message.content, 40)}</div>
    </div>
  );
}
