'use client';
import { createContext, type ReactNode, useContext, useRef } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { publishedTextCopy } from '../workspace/published-text.shell-copy';
import { FileActions } from './FileActions';
import type { FileActionSource } from './file-action-client';

type OwnerControls = { leading?: ReactNode; controls?: ReactNode };
const OwnerControlsContext = createContext<OwnerControls>({});
const HostControlsContext = createContext<ReactNode>(null);
/** The Workspace host supplies layout controls; the reader keeps the only file row. */
export const FileToolbarHostControls = HostControlsContext.Provider;
/** Existing owners project their return/version controls into the reader's single row. */
export const FileToolbarOwnerControls = OwnerControlsContext.Provider;

/** One row beneath the file tab. Entries supply controls and facts, never their own file menu. */
export function FileToolbar({
  source,
  filename,
  mime,
  byteLength,
  text,
  leading,
  location,
  controls,
  overflowControls,
  readOnlyReason,
}: {
  source: FileActionSource;
  filename: string;
  mime?: string;
  byteLength?: number;
  text?: string;
  leading?: ReactNode;
  location?: ReactNode;
  controls?: ReactNode;
  overflowControls?: ReactNode;
  readOnlyReason?: string;
}) {
  const name = useRef<HTMLSpanElement>(null);
  const localized = useShellCopy(publishedTextCopy);
  const isV2 = useShellPresentation() === 'v2';
  const copy = isV2 ? localized : publishedTextCopy.zh;
  const owner = useContext(OwnerControlsContext);
  const hostControls = useContext(HostControlsContext);
  return (
    <div
      role="toolbar"
      aria-label={copy.toolbar}
      data-testid="content-file-toolbar"
      className="content-file-toolbar flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-cafe-subtle bg-cafe-surface px-3"
    >
      {leading ?? owner.leading}
      <span ref={name} title={filename} className="min-w-0 flex-1 truncate text-xs text-cafe-muted">
        {location ?? filename}
      </span>
      {readOnlyReason && (
        <span className="shrink-0 text-xs text-cafe-muted" title={readOnlyReason}>
          {copy.readonly}
        </span>
      )}
      <div className="flex min-w-0 shrink items-center gap-1 overflow-x-auto whitespace-nowrap">
        {hostControls}
        {owner.controls}
        {controls}
      </div>
      <FileActions
        source={source}
        filename={filename}
        mime={mime}
        byteLength={byteLength}
        text={text}
        contextRef={name}
        appearance="toolbar"
        wholeWorkAction={overflowControls}
        copyName
      />
    </div>
  );
}
