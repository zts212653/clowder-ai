import { usePawFeelCopy } from '../paw-feel/paw-feel.shell-copy';
export interface AvailableDutyCat {
  catId: string;
  handle: string;
  family: string;
}

export function PawFeelDutySelect({
  label,
  value,
  cats,
  onChange,
  excludedCatId,
}: {
  label: string;
  value: string;
  cats: AvailableDutyCat[];
  onChange: (value: string) => void;
  excludedCatId: string;
}) {
  const t = usePawFeelCopy();
  const options =
    value && !cats.some((cat) => cat.catId === value)
      ? [{ catId: value, handle: `@${value}`, family: t.savedCat }, ...cats]
      : cats;

  return (
    <label className="text-xs font-medium text-cafe-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-md border border-cafe bg-cafe-surface-elevated px-2.5 py-2 text-sm text-cafe"
      >
        <option value="">{t.notAssigned}</option>
        {options
          .filter((cat) => cat.catId !== excludedCatId || cat.catId === value)
          .map((cat) => (
            <option key={cat.catId} value={cat.catId}>
              {cat.handle} · {cat.family}
            </option>
          ))}
      </select>
    </label>
  );
}
