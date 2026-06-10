import type { StoredEventMemory } from '@cat-cafe/shared';
// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest env
import React from 'react';
import { CONF, catHue, TRIGGER_LABEL, timeAgo } from './event-timeline-format';

/**
 * F227 PR-2 — EventTimeline presentational pieces (card, spine row, filter chip).
 * Split out of EventTimeline.tsx to keep each file under the 350-line redline.
 *
 * No 'use client' here: these are pure presentational children (no hooks) imported
 * only by the client EventTimeline, so they inherit its client boundary. Marking
 * this a client entry would (falsely) flag the onTeleport/onClick fn props as
 * non-serializable (RSC rule 71007).
 */

const TeleportIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
);

/** A single event card. Hero = larger, accent-tinted, full quote; compact = clamped. */
export function EventCard({
  event,
  variant,
  onTeleport,
}: {
  event: StoredEventMemory;
  variant: 'hero' | 'compact';
  onTeleport: (threadId: string, messageId: string) => void;
}) {
  const conf = CONF[event.confidence] ?? CONF.mid;
  const isHero = variant === 'hero';
  return (
    <button
      type="button"
      data-testid="event-card"
      onClick={() => onTeleport(event.threadId, event.messageId)}
      className={`group block w-full text-left rounded-xl border border-cafe-subtle shadow-sm transition-colors hover:border-cafe-accent ${
        isHero ? 'p-3.5' : 'p-3'
      }`}
      style={{ background: isHero ? 'var(--accent-50)' : 'var(--cafe-surface-elevated)' }}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${conf.badge}`}>{event.type}</span>
        <span className="text-micro text-cafe-muted">
          {TRIGGER_LABEL[event.trigger] ?? event.trigger} · {conf.label}
        </span>
        <span className="ml-auto text-micro text-cafe-muted whitespace-nowrap">{timeAgo(event.timestamp)}</span>
      </div>
      <blockquote
        className={`border-l-2 border-cafe-border bg-cafe-surface-sunken rounded-r-md px-2.5 py-1.5 text-cafe-black ${
          isHero ? 'text-sm' : 'text-xs line-clamp-1 group-hover:line-clamp-none'
        }`}
      >
        {event.summary}
      </blockquote>
      <div className="flex items-center gap-2 mt-2">
        <span className="flex items-center gap-1.5 text-micro text-cafe-secondary">
          <span
            className="grid h-[18px] w-[18px] place-items-center rounded-full text-micro font-bold text-white"
            style={{ background: `oklch(0.6 0.13 ${catHue(event.cat)})` }}
          >
            {event.cat.slice(0, 1).toUpperCase()}
          </span>
          拉闸 <b className="text-cafe-black font-semibold">{event.cat}</b>
        </span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-lg border border-cafe-accent/30 bg-cafe-accent/10 px-2 py-1 text-micro font-semibold text-cafe-accent group-hover:bg-cafe-accent/20">
          <TeleportIcon /> 跳转
        </span>
      </div>
    </button>
  );
}

/** A spine node + card row. */
export function TimelineRow({
  event,
  variant,
  onTeleport,
}: {
  event: StoredEventMemory;
  variant: 'hero' | 'compact';
  onTeleport: (threadId: string, messageId: string) => void;
}) {
  const conf = CONF[event.confidence] ?? CONF.mid;
  return (
    <div className="relative pl-9">
      <span
        className={`absolute left-[18px] top-3 rounded-full border-[3px] z-10 ${conf.node} ${conf.size}`}
        style={{ borderColor: 'var(--cafe-surface)' }}
        aria-hidden="true"
      />
      <EventCard event={event} variant={variant} onTeleport={onTeleport} />
    </div>
  );
}

export function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-cafe-accent/15 text-cafe-accent border border-cafe-accent/30'
          : 'bg-cafe-surface-sunken text-cafe-secondary border border-transparent hover:bg-cafe-accent/5'
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-micro font-bold ${active ? 'text-cafe-accent' : 'text-cafe-muted'}`}
        style={{ background: 'oklch(0 0 0 / 0.06)' }}
      >
        {count}
      </span>
    </button>
  );
}

/** Offset-pagination affordance (cloud-review P2): renders nothing when there's no next page. */
export function LoadMoreButton({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="px-5 pb-4">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-xs font-medium text-cafe-secondary transition-colors hover:border-cafe-accent hover:text-cafe-accent disabled:opacity-50"
      >
        {loading ? '加载中…' : '加载更多拉闸事件'}
      </button>
    </div>
  );
}
