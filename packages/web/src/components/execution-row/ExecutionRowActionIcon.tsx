export type ExecutionRowActionIconKind = 'continue' | 'recover' | 'reset' | 'stop';

export function ExecutionRowActionIcon({
  kind,
  className,
  testId,
}: {
  kind: ExecutionRowActionIconKind;
  className?: string;
  testId?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      data-testid={testId}
    >
      {kind === 'stop' ? <rect x="7" y="7" width="10" height="10" rx="1.5" /> : null}
      {kind === 'continue' ? <path d="m9 6 9 6-9 6Z" /> : null}
      {kind === 'recover' || kind === 'reset' ? (
        <>
          <path d="M20 7v5h-5" />
          <path d="M18.2 15.8A8 8 0 1 1 19.5 9" />
        </>
      ) : null}
    </svg>
  );
}
