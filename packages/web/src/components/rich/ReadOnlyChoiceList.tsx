/** Historical choices are text, never disabled copies of a response form. */
export function ReadOnlyChoiceList({
  options,
  selectedIds,
}: {
  options: readonly { id: string; label: string; description?: string }[];
  selectedIds: readonly string[];
}) {
  return (
    <ul className="space-y-1 text-sm" data-testid="readonly-choice-list">
      {options.map((option) => (
        <li
          key={option.id}
          data-selected={selectedIds.includes(option.id)}
          className={selectedIds.includes(option.id) ? 'text-[var(--shell-ink)]' : 'text-[var(--shell-muted)]'}
        >
          <span aria-hidden="true" className="mr-2 inline-block w-4">
            {selectedIds.includes(option.id) ? '✓' : ''}
          </span>
          {option.label}
          {option.description ? <p className="ml-6 text-xs">{option.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}
