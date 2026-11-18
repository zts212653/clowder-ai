'use client';

import { QUOTA_FAMILY_COLOR_TOKEN, type QuotaRingSummary } from './quota-pin-model';

const BAR_WIDTH = 3.6;
const BAR_GAP = 1.8;
const START_X = 2.1;
const TOP_Y = 3;
const BAR_HEIGHT = 18;
const BOTTOM_Y = TOP_Y + BAR_HEIGHT;
const CORNER_RADIUS = 1.2;
const MIN_LOW_FILL_HEIGHT = 3.5;
const DANGER_TOKEN = 'var(--quota-bar-danger, var(--shell-danger))';

/**
 * 24-grid four-family vertical usage bars (布偶 · 缅因 · 暹罗 · 梵花).
 * Never draws a fake 0% fill when a family has no non-expired active reading (`remainingPercent === null`).
 */
export function QuotaRingIcon({ summary, className = 'h-5 w-5' }: { summary: QuotaRingSummary; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-has-reading={summary.hasReading ? 'true' : 'false'}
    >
      {summary.bars.map((bar, idx) => {
        const x = Number((START_X + idx * (BAR_WIDTH + BAR_GAP)).toFixed(2));
        if (bar.remainingPercent === null) {
          return (
            <g key={bar.family} data-bar-family={bar.family} data-bar-state="empty">
              <rect
                x={x}
                y={TOP_Y}
                width={BAR_WIDTH}
                height={BAR_HEIGHT}
                rx={CORNER_RADIUS}
                fill="currentColor"
                fillOpacity={0.16}
              />
            </g>
          );
        }

        const clamped = Math.max(0, Math.min(100, bar.remainingPercent));
        const low = bar.low;
        const color = low ? DANGER_TOKEN : QUOTA_FAMILY_COLOR_TOKEN[bar.family];
        const fillHeight = Math.max(low ? MIN_LOW_FILL_HEIGHT : 0, (BAR_HEIGHT * clamped) / 100);
        const fillY = Number((BOTTOM_Y - fillHeight).toFixed(2));

        return (
          <g key={bar.family} data-bar-family={bar.family} data-bar-state={low ? 'low' : 'ok'}>
            <rect
              x={x}
              y={TOP_Y}
              width={BAR_WIDTH}
              height={BAR_HEIGHT}
              rx={CORNER_RADIUS}
              fill={color}
              fillOpacity={low ? 0.55 : 0.2}
            />
            {fillHeight > 0 && (
              <rect
                x={x}
                y={fillY}
                width={BAR_WIDTH}
                height={Number(fillHeight.toFixed(2))}
                rx={CORNER_RADIUS}
                fill={color}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
