import type { SidebarTabId } from './thread-utils';

/**
 * Inline SVG icons for sidebar tabs. Stroke style matches existing sidebar
 * icons (expand/collapse/trash). aria-hidden so screen readers skip the icon
 * and tab label/count remain the accessible name.
 */
const TAB_ICON_PATHS: Record<SidebarTabId, React.ReactNode> = {
  // Pin
  pinned: (
    <>
      <path d="M9 4h6l-1 7 4 3v2H6v-2l4-3-1-7z" />
      <path d="M12 16v4" />
    </>
  ),
  // Clock
  recent: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  // Folder
  project: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  // Server stack
  system: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="1" />
      <rect x="4" y="14" width="16" height="6" rx="1" />
      <path d="M8 7h.01M8 17h.01" />
    </>
  ),
  // Star
  favorites: <path d="M12 3l2.9 6.3 6.6.6-5 4.4 1.5 6.7L12 17.8 5.4 21l1.5-6.7-5-4.4 6.6-.6L12 3z" />,
};

export function SidebarTabIcon({ id, className = 'h-3.5 w-3.5' }: { id: SidebarTabId; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {TAB_ICON_PATHS[id]}
    </svg>
  );
}
