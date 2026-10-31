/**
 * F113 DirectoryBrowser icons.
 * Extracted from DirectoryBrowser.tsx (R3 review P2#4: split root-navigation slice).
 */

export function HomeIcon() {
  return (
    <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
    </svg>
  );
}

export function PcIcon() {
  return (
    <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 4.5A1.5 1.5 0 013.5 3h13A1.5 1.5 0 0118 4.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 12.5v-8z" />
      <path d="M4 14h12v1.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 15.5V14z" opacity="0.5" />
    </svg>
  );
}

export function DriveIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`w-4 h-4 flex-shrink-0 ${className ?? ''}`}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M2 4.5A1.5 1.5 0 013.5 3h9A1.5 1.5 0 0114 4.5v7A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-7zm2.5 6.5a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  );
}

export function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`w-4 h-4 flex-shrink-0 ${className ?? ''}`}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
    </svg>
  );
}

export function TerminalIcon() {
  return (
    <svg aria-hidden="true" className="w-3.5 h-3.5 text-cafe-muted mt-2.5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v11.5A2.25 2.25 0 0115.75 18H4.25A2.25 2.25 0 012 15.75V4.25zM7.664 6.23a.75.75 0 00-1.078 1.04l2.705 2.805-2.705 2.805a.75.75 0 001.078 1.04l3.25-3.37a.75.75 0 000-1.04l-3.25-3.28zM11 13a.75.75 0 000 1.5h3a.75.75 0 000-1.5h-3z"
        clipRule="evenodd"
      />
    </svg>
  );
}
