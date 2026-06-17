/**
 * SVG icons for DirectionCard (KD-9: all SVG, zero emoji).
 * Extracted to keep DirectionCard.tsx under the 350-line hard limit.
 */

const ICON_PROPS = {
  className: 'w-2.5 h-2.5',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const NarratorIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...ICON_PROPS}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const XIcon = () => (
  <svg {...ICON_PROPS}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const ChatIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
);

export const ArrowIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

export const DocIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);
