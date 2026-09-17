const paths = {
  branch: 'M6 3v12a4 4 0 0 0 4 4h7M6 9h8a4 4 0 0 0 4-4V3M3 3h6M15 3h6M17 16l3 3-3 3',
  experiment: 'M9 3h6M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M8 14h8',
  evidence: 'M4 4h16v16H4zM10 8l6 4-6 4z',
  environment: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
  samples: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  measurement: 'M4 20h16M6 16v-5M12 16V4M18 16V8',
  contract: 'M5 3h14v18H5zM8 10l3 3 5-6M8 17h8',
  diagnosis: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0M15 15l6 6M7 10h6',
  code: 'M8 6l-6 6 6 6M16 6l6 6-6 6M14 3l-4 18',
  compare: 'M3 7h16M15 3l4 4-4 4M21 17H5M9 13l-4 4 4 4',
  work: 'M5 4h14v12H9l-4 4zM8 8h8M8 12h5',
  focus: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 12h8M12 8v8',
  plus: 'M5 12h14M12 5v14',
  minus: 'M5 12h14',
  chevron: 'M8 4l8 8-8 8',
  check: 'M4 12l5 5L20 6',
  warning: 'M12 3L2 21h20L12 3zM12 9v5M12 17v1',
} as const;
export function ExplorationIcon({ kind, className = '' }: { kind: keyof typeof paths; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`exploration-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
