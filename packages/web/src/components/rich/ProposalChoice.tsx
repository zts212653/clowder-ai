import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import styles from './proposal-card-v2.module.css';

/** Shared presentation for the proposal's project and Group choices. Data stays with each caller. */
export function ProposalChoice({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  notice,
  triggerLabel,
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled: boolean;
  notice?: ReactNode;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [open]);
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div ref={container}>
      <button
        id={id}
        ref={trigger}
        type="button"
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        className={styles.select}
        onClick={() => setOpen(!open)}
      >
        {triggerLabel ?? options.find((option) => option.value === value)?.label ?? label} <span aria-hidden>⌄</span>
      </button>
      {open ? (
        <div
          role="group"
          aria-label={label}
          className={styles.groupList}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
            const current = choices.indexOf(document.activeElement as HTMLButtonElement);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            const start = current < 0 && step < 0 ? 0 : current;
            choices[(start + step + choices.length) % choices.length]?.focus();
          }}
        >
          <input
            ref={search}
            aria-label={label}
            placeholder={label}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {notice}
          <div id={listId} role="listbox" aria-label={label}>
            {options
              .filter((option) => !option.value || option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
              .map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  key={option.value}
                  onClick={() => choose(option.value)}
                >
                  <span>{option.value === value ? '✓' : ''}</span>
                  {option.label}
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
