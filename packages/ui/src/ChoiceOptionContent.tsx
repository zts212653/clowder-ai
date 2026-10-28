export function ChoiceOptionContent({
  label,
  description,
  selected,
}: {
  label: string;
  description?: string;
  selected?: boolean;
}) {
  return (
    <span className="cafe-choice-content flex-1 min-w-0">
      <span className={`font-semibold ${selected ? 'text-conn-amber-text' : ''}`}>{label}</span>
      {description && (
        <span className="cafe-choice-description block text-xs text-cafe-secondary mt-0.5">{description}</span>
      )}
    </span>
  );
}
