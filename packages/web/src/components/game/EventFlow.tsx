'use client';

import type { GameEvent } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';

interface EventFlowProps {
  events: GameEvent[];
  /** Map actorId → enriched display name (e.g. "布偶猫(opus)") for chat bubbles */
  catDisplayNames?: Record<string, string>;
  /** Map seatId → actorId (e.g. "P1" → "opus") for resolving speech events */
  seatToActor?: Record<string, string>;
}

const SYSTEM_EVENT_TYPES = new Set([
  'phase_change',
  'death',
  'vote_result',
  'game_start',
  'game_end',
  'announce',
  'dawn_announce',
  'exile_announce',
  'round_announce',
  'last_words_announce',
  'game_end_announce',
  'narrative',
]);

/** Announce events that should render as prominent cards (not inline text) */
const ANNOUNCE_CARD_TYPES = new Set([
  'dawn_announce',
  'exile_announce',
  'round_announce',
  'game_end_announce',
  'game_end',
  'narrative',
]);

function isSystemEvent(type: string): boolean {
  return SYSTEM_EVENT_TYPES.has(type) || type.startsWith('action.') || type.startsWith('ballot.');
}

function formatSystemMessage(event: GameEvent): string {
  if (event.payload.text) return String(event.payload.text);
  if (event.payload.message) return String(event.payload.message);
  const seat = event.payload.seatId ?? event.payload.voterSeat;
  const seatStr = seat ? String(seat) : '';
  const action = event.payload.actionName ? String(event.payload.actionName) : '';
  const target = event.payload.target ?? event.payload.choice;
  if (seatStr && action) {
    return target ? `${seatStr} ${action} → ${String(target)}` : `${seatStr} ${action}`;
  }
  if (seatStr && target) return `${seatStr} → ${String(target)}`;
  if (seatStr) return seatStr;
  return event.type;
}

/** Get card style based on announce type */
function getAnnounceCardStyle(type: string): string {
  if (type === 'narrative') return 'border-ww-cute bg-ww-cute-soft text-ww-main';
  if (type === 'dawn_announce') return 'border-ww-danger bg-ww-danger-soft text-ww-danger';
  if (type === 'exile_announce') return 'border-ww-danger bg-ww-danger-soft text-ww-danger';
  if (type === 'round_announce') return 'border-ww-info bg-ww-info-soft text-ww-info';
  if (type === 'game_end' || type === 'game_end_announce') return 'border-ww-info bg-ww-info-soft text-ww-info';
  return 'border-ww-subtle text-ww-muted';
}

export function EventFlow({ events, catDisplayNames, seatToActor }: EventFlowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [events.length]);

  return (
    <div
      data-testid="event-flow"
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-ww-base px-6 py-4 flex flex-col gap-3"
    >
      {events.map((event) => {
        // H6: Announce cards — prominent centered cards (design Screen 4)
        if (ANNOUNCE_CARD_TYPES.has(event.type)) {
          return (
            <div
              key={event.eventId}
              data-testid="announce-card"
              className={`flex items-center justify-center w-full py-2`}
            >
              <div
                className={`rounded-lg border px-4 py-2 text-center text-sm font-semibold ${getAnnounceCardStyle(event.type)}`}
              >
                {formatSystemMessage(event)}
              </div>
            </div>
          );
        }

        // Other system events — inline small text (action.*, ballot.*, etc.)
        if (isSystemEvent(event.type)) {
          return (
            <div key={event.eventId} data-testid="system-event" className="flex items-center gap-2 w-full">
              <span className="text-ww-info text-sm">🔔</span>
              <span className="text-ww-muted text-sm">{formatSystemMessage(event)}</span>
            </div>
          );
        }

        // H6: Chat bubbles with avatar circle (design Screen 4)
        const seatId = String(event.payload.seatId ?? '');
        // Resolve actorId: payload may have it directly, or map from seatId
        const rawActorId = String(event.payload.actorId ?? event.payload.senderName ?? seatToActor?.[seatId] ?? seatId);
        // Human players have userId as actorId — show "铲屎官" instead of raw userId
        const isHuman = !catDisplayNames?.[rawActorId] && rawActorId !== seatId && rawActorId !== 'system';
        const actorId = isHuman ? 'owner' : rawActorId;
        const displayName = isHuman ? '铲屎官' : (catDisplayNames?.[rawActorId] ?? rawActorId);
        const content = String(event.payload.content ?? event.payload.message ?? event.payload.text ?? '');
        const isLastWords = event.type === 'last_words';

        return (
          <div
            key={event.eventId}
            data-testid="chat-bubble"
            className={`flex gap-2.5 w-full ${isLastWords ? 'border-l-2 border-ww-danger pl-2' : ''}`}
          >
            {/* Avatar circle */}
            <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-ww-card border-2 border-ww-subtle">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={actorId === 'owner' ? '/avatars/owner.jpg' : `/avatars/${actorId}.png`}
                alt={displayName}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
            {/* Message body */}
            <div className="bg-ww-surface rounded-lg px-3.5 py-2 flex-1 flex flex-col gap-0.5">
              <span className="text-ww-cute text-xs font-semibold">
                {seatId && seatId !== actorId ? `${seatId} ` : ''}
                {displayName}
                {isLastWords ? ' · 遗言' : ' · 发言'}
              </span>
              <span className="text-ww-main text-sm">{content}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
