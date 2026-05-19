export function SettingsDeleteButton({
  onClick,
  disabled,
  'aria-label': ariaLabel = '删除',
}: {
  onClick: () => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className="rounded-full bg-conn-red-bg p-1.5 text-conn-red-text transition hover:opacity-80 disabled:opacity-50"
      aria-label={ariaLabel}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" aria-hidden="true">
        <path
          d="M3.5 4.5h9m-7.5 0V3.25h5V4.5m-5.5 0 .5 8h5l.5-8m-4 2v4m2-4v4"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
