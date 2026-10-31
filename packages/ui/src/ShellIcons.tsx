import { useId } from 'react';
import {
  MEMORY_BOOK_STAR_INNER_TRANSFORM,
  MEMORY_BOOK_STAR_OUTER_TRANSFORM,
  MEMORY_BOOK_STAR_PATH,
  MEMORY_BOOK_STAR_VIEWBOX,
} from './memory-book-star-path';

/**
 * F322 shell icons. Every concept has exactly one definition here so a re-drawn icon is a one-place change:
 *  - 作品  (WorksIcon)      two offset cards — sidebar "全部作品" and header "作品 N" share it.
 *  - 记忆  (MemoryBookStarIcon) D「星落书页」 — sidebar 记忆 and the Workspace 记忆 entry share it.
 *  - 猫猫球 (CatBallImage)   E 布偶本人 — a coloured character image, never tinted by the UI colour.
 * Stroke glyphs use the mock's 24-grid, 1.75 stroke, round caps (docs/evidence/…/home-northstar).
 */

type IconProps = { className?: string };

const STROKE_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** 作品 — mock `i-works`, including the mask that hides the back card behind the front one. */
export function WorksIcon({ className = 'h-4 w-4' }: IconProps) {
  const maskId = `${useId().replace(/:/g, '')}-works-mask`;
  return (
    <svg {...STROKE_PROPS} className={className} aria-hidden="true" focusable="false">
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" stroke="none" />
        <rect
          x="9.4"
          y="5.2"
          width="10.4"
          height="13.4"
          rx="2.6"
          transform="rotate(9 14.6 11.9)"
          fill="#000"
          stroke="#000"
          strokeWidth="3.2"
        />
      </mask>
      <rect
        x="4.2"
        y="5.4"
        width="10.4"
        height="13.4"
        rx="2.6"
        transform="rotate(-11 9.4 12.1)"
        mask={`url(#${maskId})`}
      />
      <rect x="9.4" y="5.2" width="10.4" height="13.4" rx="2.6" transform="rotate(9 14.6 11.9)" />
    </svg>
  );
}

/** 记忆 — Sol6.1's traced outline, filled, follows the text colour. */
export function MemoryBookStarIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg
      viewBox={MEMORY_BOOK_STAR_VIEWBOX}
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={MEMORY_BOOK_STAR_OUTER_TRANSFORM}>
        <g transform={MEMORY_BOOK_STAR_INNER_TRANSFORM}>
          <path d={MEMORY_BOOK_STAR_PATH} />
        </g>
      </g>
    </svg>
  );
}

/** 猫猫球 — E 布偶本人. 28 CSS px @1x, 56 px @2x; transparent, full-colour, round-safe. */
export function CatBallImage({ size = 28, className }: { size?: 28; className?: string }) {
  return (
    // biome-ignore lint/performance/noImgElement: fixed 28px character asset with explicit @2x; next/image adds no value here
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/shell/catball-E-28px.png"
      srcSet="/shell/catball-E-28px.png 1x, /shell/catball-E-28px@2x.png 2x"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      style={{ borderRadius: '50%' }}
    />
  );
}

const GLYPHS = {
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  newchat: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  checkSquare: (
    <>
      <path d="m9 11 3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  panelRight: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </>
  ),
  panelLeft: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z" />
      <path d="M19 3v4" />
      <path d="M21 5h-4" />
    </>
  ),
  grid: (
    <>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  cat: (
    <>
      <path d="M7 6 5 3v6" />
      <path d="m17 6 2-3v6" />
      <path d="M12 21c-4.42 0-8-2.69-8-6 0-4.42 3.58-8 8-8s8 3.58 8 8c0 3.31-3.58 6-8 6Z" />
      <path d="M9 14h.01M15 14h.01" />
      <path d="M10 17s1 1 2 1 2-1 2-1" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // Workspace home tool rows (home-northstar mock symbols i-folder / i-filepen / i-gitpr / i-hash / i-globe / i-activity /
  // i-hist / i-play / i-headphones / i-right, same 24-grid and stroke as the glyphs above).
  folder: (
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  ),
  filePen: (
    <>
      <path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M13.38 15.62a1 1 0 0 1 3 3L12 23l-4 1 1-4Z" />
    </>
  ),
  gitPr: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" x2="6" y1="9" y2="21" />
    </>
  ),
  hash: (
    <>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  activity: (
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  ),
  running: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4Z" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  headphones: (
    <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />,
} as const;

export type ShellGlyphName = keyof typeof GLYPHS;

export function ShellGlyph({ name, className = 'h-4 w-4' }: { name: ShellGlyphName } & IconProps) {
  return (
    <svg {...STROKE_PROPS} className={className} aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}
