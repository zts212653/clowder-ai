export function OwnerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="2">
      <path d="M17 8H19C20.1046 8 21 8.89543 21 10V12C21 13.1046 20.1046 14 19 14H17" />
      <path d="M4 8H17V15C17 17.2091 15.2091 19 13 19H8C5.79086 19 4 17.2091 4 15V8Z" />
      <path d="M10 3V5" strokeLinecap="round" />
      <path d="M14 3V5" strokeLinecap="round" />
      <path d="M6 3V5" strokeLinecap="round" />
    </svg>
  );
}
