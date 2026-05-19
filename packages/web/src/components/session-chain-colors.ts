import { hexToRgba } from '@/lib/color-utils';

// Neutral gray fallback when a session belongs to a cat that's no longer in
// cat-config.json (legacy session, removed cat). Tailwind gray-400 so it sits
// between the active-status indicator and the surface tones.
const FALLBACK_PRIMARY = '#9CA3AF';
const FALLBACK_SECONDARY = '#E5E7EB';

export interface SessionColors {
  border: string;
  badgeBg: string;
  badgeText: string;
}

export function deriveSessionColors(primary: string | undefined, secondary: string | undefined): SessionColors {
  const p = primary ?? FALLBACK_PRIMARY;
  const s = secondary ?? FALLBACK_SECONDARY;
  return {
    border: hexToRgba(p, 0.4),
    badgeBg: s,
    badgeText: p,
  };
}
