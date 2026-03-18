'use client';

import type { GameEvent } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';

interface EventFlowProps {
  events: GameEvent[];
}

const SYSTEM_EVENT_TYPES = new Set(['phase_change', 'death', 'vote_result', 'game_start', 'game_end', 'announce']);

function isSystemEvent(type: string): boolean {
  return SYSTEM_EVENT_TYPES.has(type) || type.startsWith('action.') || type.startsWith('ballot.');
}

function formatSystemMessage(event: GameEvent): string {
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

export function EventFlow({ events }: EventFlowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  return (
    <div
      data-testid="event-flow"
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-ww-base px-6 py-4 flex flex-col gap-3"
    >
      {events.map((event) => {
        if (isSystemEvent(event.type)) {
          return (
            <div key={event.eventId} data-testid="system-event" className="flex items-center gap-2 w-full">
              <span className="text-ww-info text-sm">🔔</span>
              <span className="text-ww-muted text-sm">{formatSystemMessage(event)}</span>
            </div>
          );
        }

        const sender = String(event.payload.senderName ?? event.payload.seatId ?? '');
        const content = String(event.payload.content ?? event.payload.message ?? event.payload.text ?? '');

        return (
          <div
            key={event.eventId}
            data-testid="chat-bubble"
            className="bg-ww-surface rounded-lg px-3.5 py-2.5 w-full flex flex-col gap-1"
          >
            <span className="text-ww-cute text-xs font-semibold">{sender}</span>
            <span className="text-ww-main text-sm">{content}</span>
          </div>
        );
      })}
    </div>
  );
}
