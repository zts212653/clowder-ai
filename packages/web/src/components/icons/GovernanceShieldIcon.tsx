/** Governance shield icon — shield with paw print inside */
export function GovernanceShieldIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <title>治理保护</title>
      {/* Shield outline */}
      <path d="M12 2L4 6v5c0 5.25 3.4 10.15 8 11.5 4.6-1.35 8-6.25 8-11.5V6L12 2z" opacity="0.15" />
      <path
        d="M12 2L4 6v5c0 5.25 3.4 10.15 8 11.5 4.6-1.35 8-6.25 8-11.5V6L12 2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Paw print inside shield */}
      <ellipse cx="10" cy="10.5" rx="1.3" ry="1.6" />
      <ellipse cx="14" cy="10.5" rx="1.3" ry="1.6" />
      <path d="M12 14c1.8 0 3.2 1.2 3.2 2.5 0 .8-.8 1.5-3.2 1.5s-3.2-.7-3.2-1.5C8.8 15.2 10.2 14 12 14z" />
    </svg>
  );
}
