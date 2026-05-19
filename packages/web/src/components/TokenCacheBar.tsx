'use client';

import { useEffect, useState } from 'react';

const CAT_GRADIENTS: Record<string, string> = {
  opus: 'linear-gradient(90deg, var(--color-opus-light), var(--color-opus-primary))',
  codex: 'linear-gradient(90deg, var(--color-codex-light), var(--color-codex-primary))',
  gemini: 'linear-gradient(90deg, var(--color-gemini-light), var(--color-gemini-primary))',
  dare: 'linear-gradient(90deg, var(--color-dare-light), var(--color-dare-primary))',
};

export interface TokenCacheBarProps {
  percent: number;
  catId: string;
}

/**
 * F8: Thin (2px) cache progress bar with cat brand color gradient.
 * Animates width from 0% to target with CSS transition.
 */
export function TokenCacheBar({ percent, catId }: TokenCacheBarProps) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    // Trigger animation on next frame so CSS transition fires
    const raf = requestAnimationFrame(() => setWidth(Math.min(percent, 100)));
    return () => cancelAnimationFrame(raf);
  }, [percent]);

  const gradient = CAT_GRADIENTS[catId] ?? CAT_GRADIENTS.opus;

  return (
    <div className="flex items-center gap-1.5" data-testid={`cache-bar-${catId}`}>
      <div className="flex-1 h-[3px] rounded-full bg-gray-200 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${width}%`,
            background: gradient,
            transition: 'width 600ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      </div>
      <span className="text-[10px] text-cafe-muted tabular-nums w-7 text-right">{percent}%</span>
    </div>
  );
}
