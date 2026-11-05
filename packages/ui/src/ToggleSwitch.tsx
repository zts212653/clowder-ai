export function ToggleSwitch({
  checked,
  disabled,
  label,
  describedBy,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly describedBy?: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-describedby={describedBy}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="cafe-toggle"
    >
      <span aria-hidden="true" />
    </button>
  );
}
