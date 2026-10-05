'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { ResolvedPin, SettingsEntry } from '../settings/settings-ia';
import { resolveShellNavTarget } from './shell-navigation';
import { useOpenInChat } from './use-open-in-chat';

/** Where the first section of a first-level entry lives: the old `/settings?s=` deep link, unchanged. */
function defaultSectionPath(entry: SettingsEntry): string | null {
  if (entry.destination.kind === 'theme') return '/settings?s=theme';
  if (entry.destination.kind !== 'sections') return null;
  const first = entry.destination.items.find((item) => item.kind === 'section');
  return first?.kind === 'section' ? `/settings?s=${first.sectionId}` : null;
}

/**
 * Open a 设置与管理 destination (from the settings page or from a pin on the rail) in the place that already owns it:
 * a full route, the conversation's Workspace panel, or the old settings section. No copies of anything.
 */
export function useOpenDestination(): {
  openEntry: (entry: SettingsEntry) => void;
  openPin: (pin: ResolvedPin) => void;
  /** The Workspace 猫猫团队 panel (成员能力与路由状态), a second-level item under 猫猫团队. */
  openTeam: () => void;
} {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const openInChat = useOpenInChat();
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const openTeamSubject = useChatStore((s) => s.openTeamSubject);

  const openEntry = useCallback(
    (entry: SettingsEntry) => {
      const destination = entry.destination;
      switch (destination.kind) {
        case 'route':
          router.push(resolveShellNavTarget(destination.path, pathname));
          return;
        case 'workspace-mode':
          openInChat(() => setWorkspaceMode(destination.mode));
          return;
        case 'workspace-launcher':
          // The evolution home has no typed open request yet (F307); the Workspace launcher is where it lives.
          openInChat(() => setWorkspaceMode('dev'));
          return;
        default: {
          const path = defaultSectionPath(entry);
          if (path) router.push(resolveShellNavTarget(path, pathname));
        }
      }
    },
    [openInChat, pathname, router, setWorkspaceMode],
  );

  const openTeam = useCallback(() => openInChat(() => openTeamSubject(null)), [openInChat, openTeamSubject]);

  const openPin = useCallback(
    (pin: ResolvedPin) => {
      // Old pins are plain settings sections opened standalone, exactly as before.
      if (pin.kind === 'section') {
        router.push(resolveShellNavTarget(`/settings?s=${pin.id}&standalone=1`, pathname));
        return;
      }
      // The Workspace team panel keeps its own owner; it must not collapse into `dest:team` (a settings section).
      if (pin.kind === 'workspace-team') {
        openTeam();
        return;
      }
      openEntry(pin.entry);
    },
    [openEntry, openTeam, pathname, router],
  );

  return { openEntry, openPin, openTeam };
}
