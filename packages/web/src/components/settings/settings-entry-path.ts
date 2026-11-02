import type { SettingsEntry } from './settings-ia';

/** The original first-section deep link, usable by both app navigation and external Workbench hosts. */
export function defaultSettingsSectionPath(entry: SettingsEntry): string | null {
  if (entry.destination.kind === 'you') return '/settings?s=you';
  if (entry.destination.kind === 'theme') return '/settings?s=theme';
  if (entry.destination.kind !== 'sections') return null;
  const first = entry.destination.items.find((item) => item.kind === 'section');
  return first?.kind === 'section' ? `/settings?s=${first.sectionId}` : null;
}
