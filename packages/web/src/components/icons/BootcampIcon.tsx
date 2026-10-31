/** F087: Bootcamp icon — cat silhouette with graduation cap */
export function BootcampIcon({ className = 'w-5 h-5', title = '猫猫训练营' }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <title>{title}</title>
      {/* Graduation cap */}
      <polygon points="12,2 3,7 12,12 21,7" />
      <path d="M6 8.5v4c0 1.5 2.7 3 6 3s6-1.5 6-3v-4l-6 3.5L6 8.5z" />
      <line x1="19" y1="7" x2="19" y2="14" stroke="currentColor" strokeWidth="1.2" fill="none" />
      {/* Cat ears peeking from under cap */}
      <path d="M8 12.5l-1.5 3.5h3L8 12.5z" opacity="0.7" />
      <path d="M16 12.5l1.5 3.5h-3L16 12.5z" opacity="0.7" />
      {/* Cat face hint */}
      <ellipse cx="12" cy="19" rx="4" ry="3" opacity="0.5" />
    </svg>
  );
}
