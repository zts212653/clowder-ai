/** F088 Phase G: IM Hub icon — satellite antenna/dish for connector hub */
export function HubIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <title>IM Hub</title>
      {/* Antenna base + pole */}
      <line x1="12" y1="22" x2="12" y2="13" />
      <line x1="8" y1="22" x2="16" y2="22" />
      {/* Signal dish */}
      <path d="M7 13a5 5 0 0 1 10 0" />
      <circle cx="12" cy="13" r="1" fill="currentColor" stroke="none" />
      {/* Signal waves */}
      <path d="M5.5 7.5a9 9 0 0 1 13 0" />
      <path d="M8 10a5 5 0 0 1 8 0" />
    </svg>
  );
}
