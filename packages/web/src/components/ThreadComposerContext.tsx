'use client';

import { useRef, useState } from 'react';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { AppTooltip } from './AppTooltip';
import { ComposerPopover } from './ComposerPopover';
import { composerContextCopy } from './composer-context.shell-copy';
import { ShellGlyph } from './shell/ShellIcons';
import { useShellCopy } from './shell/shell-copy';

const control =
  'shell-focusable shell-rail-item flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)]';

function ProjectPathControl({ path, pending, unavailable }: { path: string; pending: boolean; unavailable: boolean }) {
  const t = useShellCopy(composerContextCopy);
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const trigger = useRef<HTMLButtonElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  const label = path
    ? path.split(/[/\\]/).filter(Boolean).pop() || path
    : pending
      ? t.loading
      : unavailable
        ? t.unavailable
        : t.noProject;
  return (
    <>
      <AppTooltip label={path || label} side="top" multiline disabled={open}>
        <button
          ref={trigger}
          type="button"
          className={`${control} flex-1`}
          disabled={!path}
          aria-label={`${t.project}: ${path || label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="composer-project"
          onClick={() => {
            setCopyState('idle');
            setOpen(!open);
          }}
        >
          <ShellGlyph name="folder" className="h-3.5 w-3.5 flex-none" />
          <span className="min-w-0 truncate">{label}</span>
          <ShellGlyph name="chevronDown" className="h-3 w-3 flex-none" />
        </button>
      </AppTooltip>
      {open && (
        <ComposerPopover anchor={trigger} label={t.projectMenu} onClose={() => setOpen(false)}>
          <p className="break-all px-2 py-2 text-xs" data-testid="composer-project-full-path">
            {path}
          </p>
          <button type="button" className={`${control} w-full`} onClick={() => void copy()}>
            {t.copyPath}
          </button>
          {copyState !== 'idle' && (
            <output className="block px-2 py-1 text-xs">{copyState === 'copied' ? t.copied : t.copyFailed}</output>
          )}
        </ComposerPopover>
      )}
    </>
  );
}

/** Shared by full, compact and composer-only conversation hosts. */
export function ThreadComposerContext({ threadId }: { threadId: string }) {
  const { currentThread, unavailable } = useThreadDisplayInfo(threadId);
  const path = currentThread?.projectPath;
  return (
    <ProjectPathControl
      key={`${threadId}:${path ?? ''}`}
      path={path && path !== 'default' ? path : ''}
      pending={threadId !== 'default' && !currentThread && !unavailable}
      unavailable={Boolean(unavailable)}
    />
  );
}
