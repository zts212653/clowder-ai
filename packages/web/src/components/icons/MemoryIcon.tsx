/** F102 Phase J: Memory Hub icon — stylized brain/knowledge */
export function MemoryIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className={className} aria-hidden="true">
      <title>Memory Hub</title>
      {/* Brain outline */}
      <path
        d="M12 2C9 2 7 4 7 6.5c0 .5.1 1 .3 1.5C5.3 8.5 4 10 4 12c0 1.5.7 2.8 1.8 3.7-.5.8-.8 1.7-.8 2.8C5 20.5 7 22 9.5 22c1 0 1.8-.3 2.5-.7.7.4 1.5.7 2.5.7 2.5 0 4.5-1.5 4.5-3.5 0-1-.3-2-.8-2.8C19.3 14.8 20 13.5 20 12c0-2-1.3-3.5-3.3-4 .2-.5.3-1 .3-1.5C17 4 15 2 12 2z"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Center divide */}
      <path d="M12 2v20" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
      {/* Neural connections */}
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" opacity="0.6" />
      <circle cx="15" cy="9" r="1" fill="currentColor" stroke="none" opacity="0.6" />
      <circle cx="9" cy="15" r="1" fill="currentColor" stroke="none" opacity="0.6" />
      <circle cx="15" cy="15" r="1" fill="currentColor" stroke="none" opacity="0.6" />
    </svg>
  );
}
