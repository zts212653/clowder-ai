import { ShellGlyph } from '@/components/shell/ShellIcons';

/** Line marks from the signed typed-cover draft. */
export function WorkCoverIcon({ kind }: { kind: 'document' | 'layout' | 'slide' | 'code' | 'pr' | 'audio' }) {
  if (kind === 'pr') return <ShellGlyph name="gitPr" className="h-3 w-3" />;
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'audio' ? (
        <path d="M3 6.5v3M5.5 4v8M8 2.5v11M10.5 5v6M13 6.5v3" />
      ) : kind === 'code' ? (
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
      ) : kind === 'layout' || kind === 'slide' ? (
        <>
          <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
          <path d="M1.8 5.5h12.4M6 5.5v8" />
        </>
      ) : (
        <>
          <path d="M3.5 1.5h6l3 3v10h-9z" />
          <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.2h5M5.5 12.4h3" />
        </>
      )}
    </svg>
  );
}
