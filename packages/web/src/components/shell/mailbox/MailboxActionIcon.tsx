/** Mailbox presentation only, on the same 24-grid as the shell glyphs. */
export function MailboxActionIcon({ restore = false }: { restore?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 flex-none"
    >
      {restore ? (
        <>
          <path d="M3 10h6M3 10V4" />
          <path d="M4 9a8 8 0 1 1 1 9" />
        </>
      ) : (
        <>
          <path d="M3 3 21 21M10 5a11 11 0 0 1 11 7c-.7 1.6-1.7 3-3 4M6 6a13 13 0 0 0-3 6c2 4.7 6.2 7 9 7 1.5 0 3-.4 4-1" />
          <path d="M10 10a3 3 0 0 0 4 4" />
        </>
      )}
    </svg>
  );
}
