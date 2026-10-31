'use client';

import { useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { buildCatOptions } from './chat-input-options';
import { composerRoutingCopy } from './composer-routing.shell-copy';
import { buildComposerRecipientIdentities } from './composer-routing-presentation';
import { ShellCatAvatar } from './shell/ShellCatAvatar';
import { ShellGlyph } from './shell/ShellIcons';
import { useShellCopy } from './shell/shell-copy';

export interface ComposerPreferredCatControl {
  selectedCatIds: readonly string[];
  disabled?: boolean;
  onChange: (catIds: string[]) => boolean | Promise<boolean>;
  onChanged?: () => void;
}

export function ComposerPreferredCatSection({
  selectedCatIds,
  disabled,
  onChange,
  onChanged,
}: ComposerPreferredCatControl) {
  const copy = useShellCopy(composerRoutingCopy);
  const { cats } = useCatData();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const options = useMemo(() => buildCatOptions(cats).filter((option) => !option.isGroup), [cats]);
  const identities = useMemo(() => buildComposerRecipientIdentities(cats), [cats]);
  const selectedIds = useMemo(() => new Set(selectedCatIds), [selectedCatIds]);
  const selectedId = selectedCatIds[0];
  const selectedName =
    selectedCatIds.length > 1
      ? copy.preferredCount(selectedCatIds.length)
      : selectedId
        ? (identities.get(selectedId)?.label ?? copy.preferredDefault)
        : copy.preferredDefault;

  const choose = async (catIds: string[]) => {
    setSaving(true);
    setFailed(false);
    try {
      const accepted = await onChange(catIds);
      if (accepted === false) {
        setFailed(true);
        return;
      }
      onChanged?.();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-b border-cafe-subtle px-3 py-2" data-testid="composer-preferred-cat-section">
      <div className="text-xs font-medium text-cafe-secondary">{copy.preferredHeading}</div>
      <p className="mt-0.5 text-micro text-cafe-muted">{copy.preferredNote}</p>
      <button
        type="button"
        data-testid="composer-preferred-cat-toggle"
        className="shell-focusable mt-2 flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-cafe-secondary hover:bg-cafe-surface-sunken disabled:cursor-wait disabled:opacity-60"
        aria-expanded={expanded}
        disabled={disabled || saving}
        onClick={() => {
          setFailed(false);
          setExpanded((value) => !value);
        }}
      >
        {selectedCatIds.length > 1 ? (
          <span className="flex flex-none -space-x-1" aria-hidden="true">
            {selectedCatIds.slice(0, 3).map((catId) => (
              <ShellCatAvatar key={catId} catId={catId} size={20} />
            ))}
          </span>
        ) : selectedId ? (
          <ShellCatAvatar catId={selectedId} size={20} />
        ) : (
          <ShellGlyph name="cat" className="h-4 w-4" />
        )}
        <span className="min-w-0 flex-1 truncate">{saving ? copy.preferredSaving : selectedName}</span>
        <ShellGlyph name="chevronDown" className="h-3.5 w-3.5 flex-none" />
      </button>
      {failed ? (
        <p className="px-2 pt-1 text-micro text-conn-red-text" role="alert">
          {copy.preferredFailed}
        </p>
      ) : null}
      {expanded ? (
        <div className="mt-1 max-h-[40vh] overflow-y-auto rounded-lg bg-cafe-surface-sunken p-1">
          <button
            type="button"
            data-testid="composer-preferred-cat-default"
            aria-pressed={selectedCatIds.length === 0}
            className="shell-focusable flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-cafe-secondary hover:bg-cafe-surface disabled:opacity-60"
            disabled={disabled || saving}
            onClick={() => void choose([])}
          >
            <ShellGlyph name="cat" className="h-4 w-4" />
            <span className="flex-1">{copy.preferredDefault}</span>
            {selectedCatIds.length === 0 ? <ShellGlyph name="check" className="h-4 w-4" /> : null}
          </button>
          {options.map((option) => {
            const name = identities.get(option.id)?.label ?? option.label.replace(/^@/, '');
            const selected = selectedIds.has(option.id);
            return (
              <button
                key={option.id}
                type="button"
                data-testid={`composer-preferred-cat-${option.id}`}
                aria-pressed={selected}
                className="shell-focusable flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-cafe-secondary hover:bg-cafe-surface disabled:opacity-60"
                disabled={disabled || saving}
                onClick={() =>
                  void choose(
                    selected ? selectedCatIds.filter((catId) => catId !== option.id) : [...selectedCatIds, option.id],
                  )
                }
              >
                <ShellCatAvatar catId={option.id} size={20} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {selected ? <ShellGlyph name="check" className="h-4 w-4" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
