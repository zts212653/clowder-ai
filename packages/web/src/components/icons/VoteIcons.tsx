/** Vote system icons — monoline SVG, 24x24, fixed dark color for light avatar bg */

interface IconProps {
  className?: string;
  /** Fixed icon color — defaults to a dark value for light avatar backgrounds. */
  color?: string;
}

/** Ballot box: box with slot + paper going in */
export function BallotIcon({ className = 'w-5 h-5', color = '#374151' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Box body */}
      <path d="M4 10v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9" />
      {/* Box lid with slot */}
      <path d="M2 10h20" />
      <line x1="9" y1="10" x2="15" y2="10" strokeWidth="3" />
      {/* Paper ballot going into slot */}
      <rect x="9" y="3" width="6" height="8" rx="1" strokeWidth="1.5" />
      <line x1="11" y1="5.5" x2="13" y2="5.5" strokeWidth="1" />
      <line x1="11" y1="7.5" x2="13" y2="7.5" strokeWidth="1" />
    </svg>
  );
}

/** Tally chart: bar chart with results */
export function TallyIcon({ className = 'w-5 h-5', color = '#374151' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Axes */}
      <line x1="4" y1="4" x2="4" y2="20" />
      <line x1="4" y1="20" x2="20" y2="20" />
      {/* Bars */}
      <rect x="7" y="8" width="3" height="12" rx="1" fill={color} opacity="0.15" />
      <rect x="12" y="12" width="3" height="8" rx="1" fill={color} opacity="0.15" />
      <rect x="17" y="5" width="3" height="15" rx="1" fill={color} opacity="0.15" />
    </svg>
  );
}
