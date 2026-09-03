import type { ReactNode } from 'react';
import type { WorkspaceMode } from '@/lib/workspace-modes';

export function WorkspaceLauncherMark({
  mode,
}: {
  mode: WorkspaceMode | 'status' | 'theater' | 'capability-evolution';
}) {
  const paths: Record<WorkspaceMode | 'status' | 'theater' | 'capability-evolution', ReactNode> = {
    dev: <path d="M8 4 3 8l5 4M12 4l5 4-5 4M11 2 9 14" />,
    'capability-evolution': <path d="M5 2c6 3 6 9 0 12M11 2c-6 3-6 9 0 12M5.8 5h4.4M5 8h6M5.8 11h4.4" />,
    recall: <path d="M8 3a3 3 0 0 0-3 3 3 3 0 0 0 0 6 3 3 0 0 0 3-3m0-6a3 3 0 0 1 3 3 3 3 0 0 1-3-3" />,
    'needs-me': (
      <>
        <path d="M8 2.5a4 4 0 0 0-4 4v2.25L2.75 11h10.5L12 8.75V6.5a4 4 0 0 0-4-4Z" />
        <path d="M6.5 13.25h3" />
      </>
    ),
    'product-schedule': (
      <>
        <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
        <path d="M5 2v3M11 2v3M3 7h10M5.5 10h5" />
      </>
    ),
    schedule: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4v4l3 2" />
      </>
    ),
    tasks: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="m5 8 2 2 4-4" />
      </>
    ),
    team: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="11.5" cy="7" r="2" />
        <path d="M2.5 14c.5-3 2-4.5 4-4.5S10 11 10.5 14M10 10c2 0 3 1.5 3.5 4" />
      </>
    ),
    community: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="11.5" cy="7" r="2" />
        <path d="M2.5 14c.5-3 2-4.5 4-4.5S10 11 10.5 14M10 10c2 0 3 1.5 3.5 4" />
      </>
    ),
    artifacts: (
      <>
        <path d="m8 2 6 3-6 3-6-3 6-3Z" />
        <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
      </>
    ),
    approval: (
      <>
        <path d="M5 2h6l2 2v10H3V2h2" />
        <path d="m5 9 2 2 4-4M5 5h5" />
      </>
    ),
    trajectory: (
      <>
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
      </>
    ),
    eval: (
      <>
        <path d="M3 14V8M8 14V3M13 14v-4" />
        <path d="M2 14h12" />
      </>
    ),
    status: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7v4M8 4.5h.01" />
      </>
    ),
    theater: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="m7 6 4 2-4 2V6Z" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[mode]}
    </svg>
  );
}
