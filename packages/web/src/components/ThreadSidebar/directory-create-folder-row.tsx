import type { RefCallback } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import type { DirectoryBrowserCopy } from './directory-browser-copy';
import { FolderIcon } from './directory-browser-icons';

interface DirectoryCreateFolderRowProps {
  name: string;
  error: string | null;
  copy: DirectoryBrowserCopy;
  inputRef: RefCallback<HTMLInputElement>;
  onNameChange: (name: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}

export function DirectoryCreateFolderRow({
  name,
  error,
  copy,
  inputRef,
  onNameChange,
  onCreate,
  onCancel,
}: DirectoryCreateFolderRowProps) {
  const ime = useIMEGuard();
  return (
    <div className="mb-1 rounded-lg bg-cafe-surface/50 px-3 py-2 ring-2 ring-cafe-accent">
      <div className="flex items-center gap-2">
        <FolderIcon className="text-cafe-accent" />
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ime.isComposing()) {
              event.preventDefault();
              return;
            }
            if (event.key === 'Enter') onCreate();
            if (event.key === 'Escape') onCancel();
          }}
          placeholder={copy.folderNamePlaceholder}
          className="flex-1 rounded border border-cafe-accent/30 bg-cafe-surface-canvas px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-cafe-accent"
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={!name.trim()}
          className="rounded bg-cafe-accent px-2.5 py-1 text-xs text-[var(--cafe-surface)] transition-colors hover:bg-cafe-interactive disabled:opacity-40"
        >
          {copy.create}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-cafe-muted hover:text-cafe-secondary">
          {copy.cancel}
        </button>
      </div>
      {error && <p className="ml-6 mt-1 text-micro text-conn-red-text">{error}</p>}
    </div>
  );
}
