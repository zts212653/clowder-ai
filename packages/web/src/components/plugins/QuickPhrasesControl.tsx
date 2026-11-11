'use client';

import { useRef, useState } from 'react';
import { AppTooltip } from '../AppTooltip';
import { ComposerPopover } from '../ComposerPopover';
import { useShellCopy } from '../shell/shell-copy';
import { QuickPhraseConfirmation } from './QuickPhraseConfirmation';
import { QuickPhrasesList } from './QuickPhrasesList';
import { quickPhrasesCopy } from './quick-phrases.shell-copy';
import { type QuickPhrasesEntry, recordQuickPhraseUse, useQuickPhrasesEntry } from './quick-phrases-api';

type Props = {
  draft: string;
  disabled?: boolean;
  presentation: 'classic' | 'v2';
  onSelect: (text: string) => void;
};

export function QuickPhrasesControl(props: Props) {
  const entry = useQuickPhrasesEntry();
  return entry ? <QuickPhrasesButton key={entry.generation} {...props} entry={entry} /> : null;
}

function QuickPhrasesButton({ draft, disabled, presentation, onSelect, entry }: Props & { entry: QuickPhrasesEntry }) {
  const t = useShellCopy(quickPhrasesCopy);
  const anchor = useRef<HTMLButtonElement>(null);
  const [snapshot, setSnapshot] = useState<string>();
  const visible = snapshot !== undefined && !disabled;
  function close() {
    setSnapshot(undefined);
    anchor.current?.focus();
  }

  return (
    <>
      <AppTooltip label={t.title} side="top" disabled={visible}>
        <button
          ref={anchor}
          type="button"
          aria-label={t.title}
          aria-haspopup="dialog"
          aria-expanded={visible}
          disabled={disabled}
          onClick={() => setSnapshot(visible ? undefined : draft)}
          className="shell-focusable grid h-8 w-8 shrink-0 place-items-center rounded-full text-cafe-muted hover:bg-cafe-surface hover:text-cafe-accent disabled:opacity-40"
        >
          <svg
            aria-hidden="true"
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3.5h12a1 1 0 0 1 1 1v16l-7-4-7 4v-16a1 1 0 0 1 1-1ZM9 8h6m-6 4h6" />
          </svg>
        </button>
      </AppTooltip>
      {visible && (
        <ComposerPopover
          anchor={anchor}
          label={t.title}
          onClose={() => setSnapshot(undefined)}
          preferredWidth={344}
          presentation={presentation}
        >
          {snapshot.trim() ? (
            <QuickPhraseConfirmation
              entry={entry}
              intent={{ kind: 'save', text: snapshot }}
              onCancel={close}
              onSuccess={close}
            />
          ) : (
            <QuickPhrasesList
              entry={entry}
              onSelect={(phrase) => {
                setSnapshot(undefined);
                if (draft.trim()) return;
                onSelect(phrase.text);
                void recordQuickPhraseUse(entry, phrase.id);
              }}
            />
          )}
        </ComposerPopover>
      )}
    </>
  );
}
