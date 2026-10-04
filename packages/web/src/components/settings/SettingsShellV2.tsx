'use client';

import { Fragment } from 'react';
import { usePinnedSections } from '@/hooks/usePinnedSections';
import { HubIcon } from '../hub-icons';
import { useOpenDestination } from '../shell/use-open-destination';
import { SettingsContent } from './SettingsContent';
import { PinToggle } from './SettingsPinToggle';
import { SettingsSecondLevel } from './SettingsSecondLevel';
import {
  DEFAULT_SETTINGS_ENTRY_ID,
  destPinId,
  entryForSelection,
  findEntry,
  SETTINGS_IA,
  type SettingsEntry,
} from './settings-ia';
import { ThemeSettingsPanel } from './ThemeSettingsPanel';

/** The value `?s=` takes when a first-level entry is chosen: its first old section, or `theme`. */
function selectionForEntry(entry: SettingsEntry): string | null {
  const destination = entry.destination;
  if (destination.kind === 'theme') return 'theme';
  if (destination.kind !== 'sections') return null;
  const first = destination.items.find((item) => item.kind === 'section');
  return first?.kind === 'section' ? first.sectionId : null;
}

/**
 * 设置与管理 (Café 1.6): 11 first-level destinations in three hairline-separated groups, default 猫猫团队.
 * Every old section keeps its id, renderer, `/settings?s=` link and extra params; entries that live somewhere else open
 * that place instead of copying it.
 */
export function SettingsShellV2({
  selection,
  initialEditCatId,
  fixedLayout,
  onSelect,
}: {
  selection: string;
  initialEditCatId?: string;
  fixedLayout: boolean;
  onSelect: (selection: string) => void;
}) {
  const { openEntry, openTeam } = useOpenDestination();
  const { isPinned, pin, unpin } = usePinnedSections();
  const active = entryForSelection(selection) ?? findEntry(DEFAULT_SETTINGS_ENTRY_ID);
  const togglePin = (id: string) => (isPinned(id) ? unpin(id) : pin(id));

  const chooseEntry = (entry: SettingsEntry) => {
    const next = selectionForEntry(entry);
    if (next) onSelect(next);
    else openEntry(entry);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row"
      style={{ background: 'var(--shell-work)' }}
      data-testid="settings-v2"
    >
      <aside
        className="flex max-h-[42vh] w-full flex-shrink-0 flex-col overflow-hidden md:max-h-none md:w-[232px]"
        style={{ background: 'var(--shell-frame)', borderRight: '1px solid var(--shell-hairline)' }}
        data-console-panel="settings-nav"
      >
        <div className="px-4 pb-2 pt-4">
          <h1 className="m-0 text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
            设置与管理
          </h1>
        </div>
        <nav aria-label="设置与管理" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {SETTINGS_IA.map((entry, index) => {
            const isActive = active?.id === entry.id;
            const newGroup = index > 0 && SETTINGS_IA[index - 1]?.group !== entry.group;
            return (
              <Fragment key={entry.id}>
                {newGroup && (
                  <div
                    aria-hidden="true"
                    className="mx-2 my-1.5 h-px"
                    style={{ background: 'var(--shell-hairline)' }}
                  />
                )}
                <div className="group relative flex items-center">
                  <button
                    type="button"
                    onClick={() => chooseEntry(entry)}
                    aria-current={isActive ? 'page' : undefined}
                    data-active={isActive ? 'true' : 'false'}
                    data-guide-id={`settings.${entry.id}`}
                    data-testid={`settings-entry-${entry.id}`}
                    className="shell-nav-row shell-focusable flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm"
                    data-selected={isActive ? 'true' : undefined}
                    style={{
                      background: isActive ? 'var(--shell-selected)' : undefined,
                      color: isActive ? 'var(--shell-ink)' : 'var(--shell-body)',
                      fontWeight: isActive ? 500 : undefined,
                    }}
                  >
                    <span className="flex-none" style={{ color: 'var(--shell-muted)' }}>
                      <HubIcon name={entry.icon} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  </button>
                  <span
                    className={`absolute right-1 ${isPinned(destPinId(entry.id)) ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'}`}
                  >
                    <PinToggle
                      pinned={isPinned(destPinId(entry.id))}
                      label={entry.label}
                      onToggle={() => togglePin(destPinId(entry.id))}
                    />
                  </span>
                </div>
              </Fragment>
            );
          })}
        </nav>
      </aside>

      <div
        className={`min-w-0 flex-1 ${fixedLayout ? 'overflow-hidden' : 'overflow-y-auto'}`}
        data-trajectory-origin-scroll
      >
        <div
          className={`${fixedLayout ? 'flex h-full min-h-0 flex-col gap-5' : 'space-y-5'} px-5 py-5 md:px-8 md:py-7`}
        >
          {active && (
            <SettingsSecondLevel
              entry={active}
              selection={selection}
              onSelect={onSelect}
              onOpenTeam={openTeam}
              isPinned={isPinned}
              onTogglePin={togglePin}
            >
              {selection === 'theme' ? (
                <ThemeSettingsPanel />
              ) : (
                <SettingsContent section={selection} initialEditCatId={initialEditCatId} />
              )}
            </SettingsSecondLevel>
          )}
        </div>
      </div>
    </div>
  );
}
