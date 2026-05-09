import { hexToRgba } from '@/lib/color-utils';

const FALLBACK_PRIMARY = '#9CA3AF';
const FALLBACK_SECONDARY = '#E5E7EB';

export interface SessionColors {
  badgeBg: string;
  badgeText: string;
}

export function deriveSessionColors(primary?: string, secondary?: string): SessionColors {
  const p = primary ?? FALLBACK_PRIMARY;
  const s = secondary ?? FALLBACK_SECONDARY;
  return {
    badgeBg: hexToRgba(s, 0.5),
    badgeText: p,
  };
}
