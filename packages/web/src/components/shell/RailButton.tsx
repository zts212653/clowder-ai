'use client';

import { forwardRef, type ReactNode } from 'react';
import { AppTooltip } from '../AppTooltip';

/** `{ count }` is a proven number (e.g. the 小信箱's `totalCount`); an unconfirmed count is `'dot'`, never a guess. */
export type RailBadge = 'dot' | 'loading' | 'alert' | { count: number } | null;

interface RailButtonProps {
  /** Accessible name — always set; the tooltip is an aid, not the name. */
  ariaLabel: string;
  /** Tooltip first line (the control's name). */
  tip: string;
  /** Tooltip second line (state). */
  tipDetail?: ReactNode;
  selected?: boolean;
  ariaCurrent?: 'page' | undefined;
  ariaExpanded?: boolean;
  ariaHasPopup?: 'dialog' | 'menu';
  badge?: RailBadge;
  /** A look, not a disabled control: the icon is dimmed (1.6 board "需要登录") but stays focusable and clickable. */
  dimmed?: boolean;
  onClick?: () => void;
  testId?: string;
  guideId?: string;
  disableTip?: boolean;
  children: ReactNode;
}

/** 36×36 world-rail control (home-northstar mock `.rb`). Selected = one soft fill, never a ring or colour block. */
export const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(function RailButton(
  {
    ariaLabel,
    tip,
    tipDetail,
    selected = false,
    ariaCurrent,
    ariaExpanded,
    ariaHasPopup,
    badge = null,
    dimmed = false,
    onClick,
    testId,
    guideId,
    disableTip = false,
    children,
  },
  ref,
) {
  return (
    <AppTooltip label={tip} detail={tipDetail} side="right" disabled={disableTip}>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-current={ariaCurrent}
        aria-expanded={ariaExpanded}
        aria-haspopup={ariaHasPopup}
        data-selected={selected ? 'true' : undefined}
        data-dimmed={dimmed ? 'true' : undefined}
        data-testid={testId}
        data-guide-id={guideId}
        className="shell-rail-item shell-focusable relative flex h-9 w-9 flex-none items-center justify-center rounded-[9px] text-[var(--shell-muted)]"
        style={selected ? { background: 'var(--shell-selected)', color: 'var(--shell-ink)' } : undefined}
      >
        {dimmed ? (
          <span className="flex items-center justify-center" style={{ opacity: 0.4 }}>
            {children}
          </span>
        ) : (
          children
        )}
        <RailBadgeMark badge={badge} />
      </button>
    </AppTooltip>
  );
});

function RailBadgeMark({ badge }: { badge: RailBadge }) {
  if (badge !== null && typeof badge === 'object') {
    return (
      <span
        aria-hidden="true"
        data-testid="rail-badge-count"
        className="absolute right-[-2px] top-[-2px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-micro font-semibold leading-none"
        style={{
          background: 'var(--shell-primary)',
          color: 'var(--shell-primary-on)',
          boxShadow: '0 0 0 1.5px var(--shell-frame)',
        }}
      >
        {badge.count > 99 ? '99+' : badge.count}
      </span>
    );
  }
  if (badge === 'dot') {
    return (
      <span
        aria-hidden="true"
        data-testid="rail-badge-dot"
        className="absolute right-[5px] top-[5px] h-[9px] w-[9px] rounded-full"
        style={{ background: 'var(--shell-primary)', boxShadow: '0 0 0 2px var(--shell-frame)' }}
      />
    );
  }
  if (badge === 'loading') {
    return (
      <span
        aria-hidden="true"
        data-testid="rail-badge-loading"
        className="absolute right-[5px] top-[5px] h-[9px] w-[9px] rounded-full"
        style={{ border: '1.5px solid var(--shell-muted)', background: 'var(--shell-frame)' }}
      />
    );
  }
  if (badge === 'alert') {
    // 1.6 board `.bdg.er`: paper ground, a danger-coloured "!", a 1.5px danger ring.
    return (
      <span
        aria-hidden="true"
        data-testid="rail-badge-alert"
        className="absolute right-0 top-0 flex h-[15px] w-[15px] items-center justify-center rounded-full text-micro font-semibold leading-none"
        style={{
          background: 'var(--shell-paper)',
          color: 'var(--shell-danger)',
          border: '1.5px solid var(--shell-danger)',
          boxShadow: '0 0 0 1.5px var(--shell-frame)',
        }}
      >
        !
      </span>
    );
  }
  return null;
}
