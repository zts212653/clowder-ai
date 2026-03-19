/**
 * F096/F056: Café icon set — warm line SVGs for interactive blocks.
 * Replaces raw emoji with design-system-consistent icons.
 * Other cats can import and use these too.
 */

/* eslint-disable max-len -- SVG path data is inherently long */
const iconPaths: Record<string, string> = {
  // ── Ideas & creativity ─────────────────────────────
  sparkle: 'M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8Z',
  idea: 'M12 2a7 7 0 015 11.9V16a2 2 0 01-2 2h-6a2 2 0 01-2-2v-2.1A7 7 0 0112 2zm-2 18h4m-2 0v2',
  wand: 'M15 4l5 5-11 11H4v-5L15 4zm-2.5 2.5l5 5',

  // ── Communication ──────────────────────────────────
  chat: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',

  // ── Actions & games ────────────────────────────────
  game: 'M6 11h4m-2-2v4m5-1h.01M15 8h.01M21 15a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2h14a2 2 0 012 2v6z',
  dice: 'M4 4h16v16H4zm4.5 4.5h.01m7 0h.01m-3.5 3.5h.01m-3.5 3.5h.01m7 0h.01',
  shuffle: 'M16 3l4 4-4 4M20 7H4m4 14l-4-4 4-4M4 17h16',

  // ── Data & analysis ────────────────────────────────
  chart: 'M18 20V10M12 20V4M6 20v-6',
  trending: 'M23 6l-9.5 9.5-5-5L1 18',
  target: 'M12 12m-10 0a10 10 0 1020 0 10 10 0 10-20 0m4 0a6 6 0 1012 0 6 6 0 10-12 0m4 0a2 2 0 104 0 2 2 0 10-4 0',
  globe:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm0 0c-2.5 2.7-4 6.2-4 10s1.5 7.3 4 10m0-20c2.5 2.7 4 6.2 4 10s-1.5 7.3-4 10M2 12h20',
  scale:
    'M12 4v16m-7-2h14M5 8h5m4 0h5m-14 0l-2.5 4.5A2.5 2.5 0 005 16a2.5 2.5 0 002.5-3.5L5 8zm14 0l2.5 4.5A2.5 2.5 0 0119 16a2.5 2.5 0 01-2.5-3.5L19 8z',
  trophy:
    'M8 4h8v3a4 4 0 01-8 0V4zm-3 1h3v2a3 3 0 01-3 3H4a3 3 0 01-3-3V5h4zm14 0h4v2a3 3 0 01-3 3h-1a3 3 0 01-3-3V5h3zM12 11v4m-4 5h8m-7-2v2m6-2v2',
  architecture: 'M3 7h18M3 17h18M6 7v10m12-10v10M9 7v10m6-10v10M5 17h14v3H5zM10 2h4v3h-4z',
  code: 'M8 8l-4 4 4 4m8-8 4 4-4 4m-4-9-2 10',
  bug: 'M8 9V7a4 4 0 118 0v2m-8 0h8M12 9v11m-6-7H3m3 4H2m16-4h3m-3 4h4M8 12a4 4 0 008 0v3a4 4 0 01-8 0v-3z',
  flame:
    'M12 3s4 3.5 4 7a4 4 0 11-8 0c0-2.5 1.5-4.5 4-7zm0 8c1.5 1 2.5 2.2 2.5 3.8a2.5 2.5 0 11-5 0c0-1.6 1-2.8 2.5-3.8z',
  bolt: 'M13 2L4 13h6l-1 9 9-11h-6l1-9z',
  tool: 'M21 3l-4.2 4.2a4 4 0 01-5.6 5.6L4 20l-2-2 7.2-7.2a4 4 0 005.6-5.6L19 1l2 2z',
  backpack: 'M7 8V6a5 5 0 0110 0v2m-10 0h10a2 2 0 012 2v9a3 3 0 01-3 3H8a3 3 0 01-3-3v-9a2 2 0 012-2zm3 0h4m-4 6h4',
  graduation: 'M12 3L2 8l10 5 10-5-10-5zm-6 7v4c0 1.8 2.7 3 6 3s6-1.2 6-3v-4',
  utensils: 'M4 2v8m3-8v8M4 6h3m3-4h2v20m4-20v9a3 3 0 01-3 3h-1v8m5-20h2m0 0v9a3 3 0 01-3 3',
  sun: 'M12 3v2m0 14v2m9-9h-2M5 12H3m15.36 6.36-1.42-1.42M7.05 7.05 5.64 5.64m12.72 0-1.42 1.41M7.05 16.95l-1.41 1.41M12 7a5 5 0 100 10 5 5 0 000-10z',

  // ── UI & design ────────────────────────────────────
  palette:
    'M12 2a10 10 0 000 20c.55 0 1-.45 1-1 0-.28-.11-.53-.3-.7a1.49 1.49 0 01-.7-1.3c0-.83.67-1.5 1.5-1.5H16a6 6 0 006-6c0-5.52-4.48-10-10-10z',
  moon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',

  // ── Nature & warmth (café vibes) ───────────────────
  coffee: 'M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8zm0-4h16',
  cat: 'M12 20c-4.42 0-8-2.69-8-6s3.58-8 8-8 8 4.69 8 8-3.58 6-8 6zm-2-8h.01M14 12h.01M9 16s1.5 2 3 2 3-2 3-2M7 3l2 3m8-3l-2 3',
  heart:
    'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z',
  leaf: 'M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66L17 8zm-7 4A5 5 0 0120 8',
  paw: 'M12 18c-1 0-2-.5-2.5-1.5S9 14 9 13s1-2.5 3-2.5 3 1.5 3 2.5-.5 2.5-1 3.5S13 18 12 18zm-4-7a2 2 0 110-4 2 2 0 010 4zm8 0a2 2 0 110-4 2 2 0 010 4zm-10 4a2 2 0 110-4 2 2 0 010 4zm12 0a2 2 0 110-4 2 2 0 010 4z',

  // ── Utility ────────────────────────────────────────
  check: 'M5 13l4 4L19 7',
  cross: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14m-7-7h14',
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  tree: 'M12 22V8m0 0l-4 4m4-4l4 4M8 2l4 6 4-6',
  test: 'M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2zM14 2v6h6m-4 5H8m8 4H8m2-8H8',
};

/** Render a café icon by name. Falls back to null if name is unknown. */
export function CafeIcon({ name, className = 'w-5 h-5' }: { name: string; className?: string }) {
  const d = iconPaths[name];
  if (!d) return null;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/** Get all available icon names (for documentation/autocomplete) */
export const cafeIconNames = Object.keys(iconPaths);
