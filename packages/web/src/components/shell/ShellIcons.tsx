export { CatBallImage, MemoryBookStarIcon, ShellGlyph, type ShellGlyphName, WorksIcon } from '@cat-cafe/ui';

/** You's chosen C from docs/evidence/2026-10-26-f322-undrawn/art/yarn-C.svg. */
export function YarnBallIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className={className}
      data-shell-yarn-ball="C"
    >
      <circle cx="8" cy="8" r="6.3" fill="#c46a4d" stroke="#8f4730" strokeWidth="1" />
      <g fill="none" stroke="#f3e3da" strokeOpacity=".8" strokeWidth=".9" strokeLinecap="round">
        <path d="M2.9 6.1 Q8 2 13.1 6.1" />
        <path d="M2.3 8.8 Q8 5.4 13.7 8.8" />
        <path d="M3.4 11.5 Q8 8.5 12.6 11.5" />
        <path d="M6.7 1.9 Q10.8 8 7.4 14.2" />
      </g>
    </svg>
  );
}
