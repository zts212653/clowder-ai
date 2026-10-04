'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { HubIcon } from '../hub-icons';
import { PinToggle } from './SettingsPinToggle';
import { type SettingsEntry, sectionLabel } from './settings-ia';

const PANEL_ID = 'settings-tabpanel';
const tabDomId = (sectionId: string) => `settings-tab-${sectionId}`;

/**
 * Second level of a section-based first-level item: the old sections as WAI-ARIA tabs (one tab stop, Left/Right/Home/End
 * move focus, Enter/Space selects — manual activation, because every section loads its own data) with ONE named tabpanel.
 * The Workspace team panel is an ordinary action beside the tabs, not a tab: it leaves settings.
 */
export function SettingsSecondLevel({
  entry,
  selection,
  onSelect,
  onOpenTeam,
  isPinned,
  onTogglePin,
  children,
}: {
  entry: SettingsEntry;
  selection: string;
  onSelect: (sectionId: string) => void;
  onOpenTeam: () => void;
  isPinned: (pinId: string) => boolean;
  onTogglePin: (pinId: string) => void;
  children: ReactNode;
}) {
  if (entry.destination.kind !== 'sections') return <>{children}</>;
  const items = entry.destination.items;
  const sectionIds = items.flatMap((item) => (item.kind === 'section' ? [item.sectionId] : []));
  const teamItem = items.find((item) => item.kind === 'workspace-team');
  const selectedIsKnown = sectionIds.includes(selection);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const last = sectionIds.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = sectionIds[next];
    if (target) document.getElementById(tabDomId(target))?.focus();
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={`${entry.label}的分区`} className="flex flex-wrap items-center gap-1">
          {sectionIds.map((sectionId, index) => {
            const current = sectionId === selection;
            // one tab stop: the selected tab, or the first one when the URL names no known section
            const tabStop = current || (!selectedIsKnown && index === 0);
            return (
              <button
                key={sectionId}
                id={tabDomId(sectionId)}
                type="button"
                role="tab"
                aria-selected={current}
                aria-controls={PANEL_ID}
                tabIndex={tabStop ? 0 : -1}
                onClick={() => onSelect(sectionId)}
                onKeyDown={(event) => onKeyDown(event, index)}
                data-testid={`settings-tab-${sectionId}`}
                className="shell-nav-row shell-focusable h-8 rounded-lg px-3 text-sm"
                data-selected={current ? 'true' : undefined}
                style={{
                  background: current ? 'var(--shell-selected)' : undefined,
                  color: current ? 'var(--shell-ink)' : 'var(--shell-body)',
                  fontWeight: current ? 500 : undefined,
                }}
              >
                {sectionLabel(sectionId)}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          {selectedIsKnown && (
            <PinToggle
              pinned={isPinned(selection)}
              label={sectionLabel(selection)}
              onToggle={() => onTogglePin(selection)}
            />
          )}
          {teamItem?.kind === 'workspace-team' && (
            <span className="flex items-center">
              <button
                type="button"
                onClick={onOpenTeam}
                data-testid="settings-team-workspace"
                className="shell-focusable h-8 rounded-lg px-3 text-sm"
                style={{ color: 'var(--shell-body)' }}
              >
                <span className="inline-flex items-center gap-1">
                  {teamItem.label}
                  <HubIcon name="external-link" className="h-3 w-3" />
                </span>
              </button>
              <PinToggle
                pinned={isPinned(teamItem.pinId)}
                label={teamItem.label}
                onToggle={() => onTogglePin(teamItem.pinId)}
              />
            </span>
          )}
        </div>
      </div>
      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={selectedIsKnown ? tabDomId(selection) : undefined}
        aria-label={selectedIsKnown ? undefined : `${entry.label}`}
        tabIndex={-1}
        className="space-y-5 outline-none"
      >
        {children}
      </div>
    </>
  );
}
