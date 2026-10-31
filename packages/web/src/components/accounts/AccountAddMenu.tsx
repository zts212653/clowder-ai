'use client';
import { useEffect, useRef, useState } from 'react';
import type { ProfileAuthType } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { accountsCopy } from './accounts.shell-copy';

export function AccountAddMenu({
  onAdd,
  onAddClaude,
}: {
  onAdd: (type: ProfileAuthType) => void;
  onAddClaude?: () => void;
}) {
  const t = useShellCopy(accountsCopy);
  const [open, setOpen] = useState(false);
  const owner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!owner.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  function choose(type: ProfileAuthType) {
    setOpen(false);
    onAdd(type);
  }
  return (
    <div
      className="account-add"
      ref={owner}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="account-primary"
        data-guide-id="accounts.create-form"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t.add}
      </button>
      {open && (
        <div className="account-add-menu">
          <p>{t.officialLogin}</p>
          <button type="button" onClick={() => choose('oauth')}>
            {t.addCodex}
          </button>
          {onAddClaude && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddClaude();
              }}
            >
              {t.addClaude}
            </button>
          )}
          <small>{t.addNotice}</small>
          <hr />
          <button type="button" onClick={() => choose('api_key')}>
            {t.addKey}
          </button>
          <small>{t.addKeyHint}</small>
        </div>
      )}
    </div>
  );
}
