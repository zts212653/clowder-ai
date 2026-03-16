'use client';

import type { SeatId, SeatView } from '@cat-cafe/shared';

interface NightActionCardProps {
  roleName: string;
  roleIcon: string;
  actionLabel: string;
  hint: string;
  targets: SeatView[];
  selectedTarget: SeatId | null;
  onSelectTarget: (seatId: SeatId) => void;
  onConfirm: () => void;
  disabled?: boolean;
  /** For witch: alternate action label (e.g. "毒杀") */
  altActionLabel?: string;
  /** For witch: confirm alternate action */
  onConfirmAlt?: () => void;
}

export function NightActionCard({
  roleName,
  roleIcon,
  actionLabel,
  hint,
  targets,
  selectedTarget,
  onSelectTarget,
  onConfirm,
  disabled = false,
  altActionLabel,
  onConfirmAlt,
}: NightActionCardProps) {
  return (
    <div
      data-testid="night-action-card"
      className="bg-ww-topbar border border-ww-subtle rounded-xl p-5 flex flex-col gap-4 w-[400px]"
    >
      {/* Role header */}
      <div className="flex items-center gap-2">
        <span className="text-lg">{roleIcon}</span>
        <span className="text-ww-main text-sm font-semibold">
          {roleName} — {actionLabel}
        </span>
      </div>

      {/* Target grid */}
      <div data-testid="target-grid" className="flex gap-2 justify-center flex-wrap">
        {targets.map((seat) => {
          const isSelected = seat.seatId === selectedTarget;
          const isDead = !seat.alive;
          return (
            <button
              type="button"
              key={seat.seatId}
              data-testid={`target-${seat.seatId}`}
              onClick={() => !isDead && onSelectTarget(seat.seatId)}
              disabled={isDead || disabled}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-lg w-14 h-16 ${
                isSelected ? 'bg-ww-card border-2 border-ww-cute' : 'bg-ww-card border-2 border-transparent'
              }${isDead ? ' opacity-40' : ''}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/avatars/${seat.actorId}.png`}
                alt={seat.displayName}
                className="w-7 h-7 rounded-full object-cover"
              />
              <span className="text-[9px] text-ww-muted font-semibold truncate max-w-[52px]">
                {seat.seatId} {seat.displayName}
              </span>
            </button>
          );
        })}
      </div>

      {/* Confirm button */}
      <button
        type="button"
        data-testid="confirm-btn"
        onClick={onConfirm}
        disabled={!selectedTarget || disabled}
        className="bg-ww-cute text-ww-base font-bold text-sm rounded-lg h-10 w-full disabled:opacity-50"
      >
        {selectedTarget ? `确认${actionLabel} ${selectedTarget}` : `请选择目标`}
      </button>

      {/* Alternate action button (e.g. witch poison) */}
      {altActionLabel && onConfirmAlt && (
        <button
          type="button"
          data-testid="confirm-alt-btn"
          onClick={onConfirmAlt}
          disabled={!selectedTarget || disabled}
          className="bg-ww-witch text-ww-main font-bold text-sm rounded-lg h-10 w-full disabled:opacity-50"
        >
          {selectedTarget ? `确认${altActionLabel} ${selectedTarget}` : `请选择目标`}
        </button>
      )}

      {/* Hint */}
      <span className="text-ww-dim text-xs text-center">{hint}</span>
    </div>
  );
}
