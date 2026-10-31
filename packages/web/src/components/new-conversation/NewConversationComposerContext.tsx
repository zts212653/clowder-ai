'use client';

import { useMemo, useRef, useState } from 'react';
import { AppTooltip } from '../AppTooltip';
import { ComposerPopover } from '../ComposerPopover';
import { ShellGlyph } from '../shell/ShellIcons';
import { useShellCopy } from '../shell/shell-copy';
import { DirectoryBrowser } from '../ThreadSidebar/DirectoryBrowser';
import { ProjectOption } from '../ThreadSidebar/ProjectOption';
import { projectDisplayName } from '../ThreadSidebar/thread-utils';
import styles from './NewConversationComposerContext.module.css';
import { newConversationCopy } from './new-conversation.shell-copy';

const CONTROL =
  'shell-focusable shell-rail-item flex h-8 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-lg px-1.5 text-xs text-[var(--shell-muted)] disabled:cursor-not-allowed disabled:opacity-60';

interface NewConversationComposerContextProps {
  projectPath?: string;
  existingProjects: string[];
  locked: boolean;
  pinned: boolean;
  onProjectChange: (projectPath: string | undefined) => void;
  onPinnedChange: (pinned: boolean) => void;
}

function LobbyOption({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  const copy = useShellCopy(newConversationCopy);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-cafe-surface ${
        selected ? 'bg-cafe-surface ring-2 ring-cafe-accent' : ''
      }`}
    >
      <ShellGlyph name="grid" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 text-cafe-secondary">{copy.lobby}</span>
      <span
        aria-hidden="true"
        className={`h-4 w-4 rounded-full border ${selected ? 'border-cafe-accent bg-cafe-accent' : 'border-cafe'}`}
      />
    </button>
  );
}

function ProjectControl({
  projectPath,
  existingProjects,
  locked,
  onChange,
}: Pick<NewConversationComposerContextProps, 'projectPath' | 'existingProjects' | 'locked'> & {
  onChange: (path: string | undefined) => void;
}) {
  const copy = useShellCopy(newConversationCopy);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const choices = useMemo(() => {
    const unique = new Set(existingProjects);
    if (projectPath) unique.add(projectPath);
    return [...unique];
  }, [existingProjects, projectPath]);
  const label = projectPath ? projectDisplayName(projectPath) : copy.lobby;

  const select = (path: string | undefined) => {
    onChange(path);
    setBrowsing(false);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <AppTooltip
        label={locked ? copy.optionsLocked : `${copy.project}: ${projectPath ?? copy.lobby}`}
        side="top"
        multiline
      >
        <button
          ref={trigger}
          type="button"
          className={`${styles.projectControl} ${CONTROL} min-w-[5.75rem] max-w-48 flex-none max-sm:w-1/3 max-sm:min-w-5 max-sm:max-w-[33.333%] max-sm:flex-[1_1_33.333%] max-sm:px-0.5`}
          disabled={locked}
          aria-label={`${copy.project}: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="new-conversation-project"
          onClick={() => setOpen((value) => !value)}
        >
          <ShellGlyph name="folder" className="h-3.5 w-3.5 flex-none max-sm:hidden" />
          <span
            className={`${styles.projectName} min-w-0 truncate whitespace-nowrap`}
            data-testid="new-conversation-project-name"
            data-compact-name-policy="whole-or-hidden"
          >
            {label}
          </span>
          <ShellGlyph name="chevronDown" className="h-3 w-3 flex-none" />
        </button>
      </AppTooltip>
      {open && (
        <ComposerPopover
          anchor={trigger}
          label={copy.projectMenu}
          onClose={() => {
            setOpen(false);
            setBrowsing(false);
          }}
          preferredWidth={browsing ? 560 : 520}
        >
          {browsing ? (
            <div className="h-[min(60vh,440px)] min-h-[280px]">
              <DirectoryBrowser
                initialPath={projectPath}
                activeProjectPath={projectPath}
                onCancel={() => setBrowsing(false)}
                onSelectCurrent={select}
                selectCurrentLabel={copy.useFolder}
                copy={copy.directoryBrowser}
              />
            </div>
          ) : (
            <div className="space-y-1 p-1">
              <LobbyOption selected={!projectPath} onSelect={() => select(undefined)} />
              {choices.map((path) => (
                <ProjectOption
                  key={path}
                  path={path}
                  selected={path === projectPath}
                  nameLabel={copy.projectNameLabel}
                  pathLabel={copy.projectPathLabel}
                  selectAriaLabel={copy.selectProject(projectDisplayName(path), path)}
                  onSelect={() => select(path)}
                />
              ))}
              <button
                type="button"
                className="shell-focusable mt-1 flex w-full items-center gap-2 rounded-lg border-t border-[var(--shell-hairline)] px-3 py-2.5 text-left text-sm text-cafe-secondary hover:bg-cafe-surface"
                onClick={() => setBrowsing(true)}
              >
                <ShellGlyph name="folder" className="h-4 w-4" />
                {copy.browse}
              </button>
            </div>
          )}
        </ComposerPopover>
      )}
    </>
  );
}

export function NewConversationComposerContext(props: NewConversationComposerContextProps) {
  const copy = useShellCopy(newConversationCopy);
  return (
    <>
      <ProjectControl
        projectPath={props.projectPath}
        existingProjects={props.existingProjects}
        locked={props.locked}
        onChange={props.onProjectChange}
      />
      <label
        className={`shell-focusable flex h-8 flex-none items-center gap-1.5 rounded-lg px-1.5 text-xs text-[var(--shell-muted)] max-sm:absolute max-sm:right-3 max-sm:top-1.5 max-sm:z-10 max-sm:px-0.5 ${
          props.locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
        }`}
      >
        <input
          type="checkbox"
          checked={props.pinned}
          disabled={props.locked}
          data-testid="new-conversation-pin"
          aria-label={copy.pinAfterCreating}
          className="shell-focusable h-3.5 w-3.5 flex-none accent-[var(--shell-ink)]"
          onChange={(event) => props.onPinnedChange(event.target.checked)}
        />
        <span className="whitespace-nowrap sm:hidden">{copy.pinAfterCreatingShort}</span>
        <span className="hidden whitespace-nowrap sm:inline">{copy.pinAfterCreating}</span>
      </label>
    </>
  );
}
