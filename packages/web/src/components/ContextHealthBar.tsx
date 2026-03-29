'use client';

import { useEffect, useState } from 'react';
import type { ContextHealthData } from '@/stores/chat-types';

const CAT_BG_COLORS: Record<string, string> = {
  opus: 'var(--color-opus-primary)',
  codex: 'var(--color-codex-primary)',
  gemini: 'var(--color-gemini-primary)',
  // Variant-specific shades (same family, different tones)
  gpt52: '#66BB6A',
  'opus-45': '#7E57C2',
  sonnet: '#B39DDB',
};

const WARN_COLOR = '#f59e0b'; // amber-500
const DANGER_COLOR = '#ef4444'; // red-500

export interface ContextHealthBarProps {
  catId: string;
  health: ContextHealthData;
  /** Warning threshold (default 0.70) */
  warnThreshold?: number;
  /** Danger threshold (default 0.85) */
  dangerThreshold?: number;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * F24: Context health progress bar.
 * Thin bar showing context window fill ratio with color coding:
 * - Below warn: cat brand color
 * - warn ~ danger: amber
 * - Above danger: red + pulse animation
 */
export function ContextHealthBar({
  catId,
  health,
  warnThreshold = 0.7,
  dangerThreshold = 0.85,
}: ContextHealthBarProps) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setWidth(Math.min(health.fillRatio * 100, 100)));
    return () => cancelAnimationFrame(raf);
  }, [health.fillRatio]);

  const isDanger = health.fillRatio >= dangerThreshold;
  const isWarn = health.fillRatio >= warnThreshold;

  let barColor: string;
  if (isDanger) {
    barColor = DANGER_COLOR;
  } else if (isWarn) {
    barColor = WARN_COLOR;
  } else {
    barColor = CAT_BG_COLORS[catId] ?? CAT_BG_COLORS.opus;
  }

  const approxPrefix = health.source === 'approx' ? '~' : '';
  const percent = Math.round(health.fillRatio * 100);
  const tooltip = `Context: ${approxPrefix}${percent}% (${formatTokenCount(health.usedTokens)} / ${formatTokenCount(health.windowTokens)} tokens)`;

  return (
    <div className="mt-1" title={tooltip} data-testid={`context-health-${catId}`}>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-[3px] rounded-full bg-gray-200 overflow-hidden">
          <div
            className={`h-full rounded-full ${isDanger ? 'animate-pulse' : ''}`}
            style={{
              width: `${width}%`,
              backgroundColor: barColor,
              transition: 'width 600ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          />
        </div>
        <span className="text-[10px] text-cafe-muted tabular-nums w-8 text-right">
          {approxPrefix}
          {percent}%
        </span>
      </div>
    </div>
  );
}
