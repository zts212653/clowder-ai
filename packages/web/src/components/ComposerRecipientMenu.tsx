'use client';

import type { RefObject } from 'react';
import { ComposerPopover } from './ComposerPopover';
import type { CatOption } from './chat-input-options';
import { composerRoutingCopy } from './composer-routing.shell-copy';
import type { ComposerRecipientIdentity } from './composer-routing-presentation';
import { ShellCatAvatar } from './shell/ShellCatAvatar';

type ComposerRoutingWords = typeof composerRoutingCopy.zh;
export type ComposerRecipientOption = Omit<CatOption, 'insert'> & { insert: string | null };

export function ComposerRecipientMenu({
  anchor,
  copy,
  identities,
  onClose,
  onInsertMention,
  options,
}: {
  anchor: RefObject<HTMLButtonElement>;
  copy: ComposerRoutingWords;
  identities: ReadonlyMap<string, ComposerRecipientIdentity>;
  onClose: () => void;
  onInsertMention: (option: CatOption) => void;
  options: ComposerRecipientOption[];
}) {
  return (
    <ComposerPopover anchor={anchor} label={copy.recipientMenu} onClose={onClose}>
      <p className="border-b border-[var(--shell-hairline)] px-3 py-2 text-xs text-cafe-muted">
        {copy.recipientMenuNote}
      </p>
      <div className="max-h-[50vh] overflow-y-auto p-1.5">
        {options.map((option) => {
          const name = identities.get(option.id)?.label ?? option.label.replace(/^@/, '');
          const insert = option.insert;
          return (
            <button
              key={option.id}
              type="button"
              data-testid={`composer-recipient-${option.id}`}
              disabled={!insert}
              className="shell-focusable flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-cafe-secondary hover:bg-cafe-surface-sunken disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
              onClick={() => {
                if (!insert) return;
                onInsertMention({ ...option, insert });
                onClose();
                anchor.current?.focus();
              }}
            >
              <ShellCatAvatar catId={option.id} size={22} />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-xs text-cafe-muted">{insert?.trim() ?? copy.recipientUnavailable}</span>
            </button>
          );
        })}
      </div>
    </ComposerPopover>
  );
}
