'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { defaultSettingsSectionPath } from '../settings/settings-entry-path';
import type { ResolvedPin, SettingsEntry } from '../settings/settings-ia';
import { isSettingsRoute } from './settings-reading-bridge';
import { resolveShellNavTarget } from './shell-navigation';
import { useOpenInChat } from './use-open-in-chat';
import { useSettingsReadingEntry } from './useSettingsSourceReturn';

/**
 * Open a 设置与管理 destination (from the settings page or from a pin on the rail) in the place that already owns it:
 * a full route, the conversation's Workspace panel, or the old settings section. No copies of anything.
 */
export function useOpenDestination(): {
  openEntry: (entry: SettingsEntry) => void;
  openPin: (pin: ResolvedPin) => void;
  /** Open the original Workspace team panel for an already-saved rail shortcut. */
  openTeam: () => void;
} {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const captureSettingsOrigin = useSettingsReadingEntry();
  const openRoute = useCallback(
    (path: string) => {
      if (isSettingsRoute(path.split('?')[0])) captureSettingsOrigin();
      router.push(resolveShellNavTarget(path, pathname));
    },
    [captureSettingsOrigin, router, pathname],
  );
  const openInChat = useOpenInChat();
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const openEvolutionWorkspace = useChatStore((s) => s.openEvolutionWorkspace);
  const openTeamSubject = useChatStore((s) => s.openTeamSubject);

  const openEntry = useCallback(
    (entry: SettingsEntry) => {
      const destination = entry.destination;
      switch (destination.kind) {
        case 'route':
          openRoute(destination.path);
          return;
        case 'workspace-mode':
          openInChat(() => setWorkspaceMode(destination.mode));
          return;
        case 'evolution-home':
          openInChat(openEvolutionWorkspace);
          return;
        default: {
          const path = defaultSettingsSectionPath(entry);
          if (path) openRoute(path);
        }
      }
    },
    [openInChat, openRoute, setWorkspaceMode, openEvolutionWorkspace],
  );

  const openTeam = useCallback(() => openInChat(() => openTeamSubject(null)), [openInChat, openTeamSubject]);

  const openPin = useCallback(
    (pin: ResolvedPin) => {
      // Old pins are plain settings sections opened standalone, exactly as before.
      if (pin.kind === 'section') {
        openRoute(`/settings?s=${pin.id}&standalone=1`);
        return;
      }
      // The Workspace team panel keeps its own owner; it must not collapse into `dest:team` (a settings section).
      if (pin.kind === 'workspace-team') {
        openTeam();
        return;
      }
      openEntry(pin.entry);
    },
    [openEntry, openTeam, openRoute],
  );

  return { openEntry, openPin, openTeam };
}
