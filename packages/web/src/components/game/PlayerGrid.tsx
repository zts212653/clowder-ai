'use client';

import type { SeatId, SeatView } from '@cat-cafe/shared';

interface SeatStatusInput {
  alive: boolean;
  ready?: boolean;
  gameStatus?: string;
  hasActed?: boolean;
}

export function deriveSeatStatus(input: SeatStatusInput): string {
  if (!input.alive) return '死亡';
  if (input.gameStatus === 'lobby') return input.ready ? '准备中' : '加载中…';
  if (input.gameStatus === 'paused') return '暂停';
  if (input.gameStatus === 'finished') return '结束';
  return input.hasActed ? '✓ 已行动' : '等待';
}

interface PlayerGridProps {
  seats: SeatView[];
  activeSeatId?: SeatId | null;
  gameStatus?: string;
  onSeatClick?: (seatId: SeatId) => void;
}

export function PlayerGrid({ seats, activeSeatId, gameStatus, onSeatClick }: PlayerGridProps) {
  return (
    <div
      data-testid="player-grid"
      className="flex items-center justify-center gap-2 bg-ww-topbar px-6 py-2 h-20 w-full"
    >
      {seats.map((seat) => {
        const isActive = seat.seatId === activeSeatId;
        const isDead = !seat.alive;

        return (
          <button
            type="button"
            key={seat.seatId}
            data-testid={`seat-${seat.seatId}`}
            onClick={() => onSeatClick?.(seat.seatId)}
            className={`flex flex-col items-center justify-center gap-0.5 rounded-lg w-14 h-16 ${
              isActive ? 'bg-ww-cute text-ww-base' : 'bg-ww-card text-ww-muted'
            }${isDead ? ' opacity-40' : ''}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/avatars/${seat.actorId}.png`}
              alt={seat.displayName}
              className="w-7 h-7 rounded-full object-cover border-2 border-ww-subtle"
            />
            <span
              className={`text-[9px] font-semibold truncate max-w-[52px] ${isActive ? 'text-ww-base font-bold' : ''}`}
            >
              {seat.seatId} {seat.displayName}
            </span>
            <span className={`text-[8px] font-mono ${isActive ? 'text-ww-base font-semibold' : 'text-ww-dim'}`}>
              {isActive ? '发言中' : deriveSeatStatus({ alive: seat.alive, gameStatus, hasActed: seat.hasActed })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
