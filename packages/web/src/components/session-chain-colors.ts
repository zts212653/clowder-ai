export interface SessionColors {
  border: string;
  badgeBg: string;
  badgeText: string;
}

export function deriveSessionColors(): SessionColors {
  return {
    border: 'color-mix(in srgb, var(--cafe-accent) 25%, transparent)',
    badgeBg: 'color-mix(in srgb, var(--cafe-accent) 14%, var(--console-card-bg) 86%)',
    badgeText: 'var(--cafe-accent)',
  };
}
