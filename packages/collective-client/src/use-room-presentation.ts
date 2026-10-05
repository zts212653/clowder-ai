import { useSyncExternalStore } from 'react';

import { hostAppearance } from './host-appearance.js';
import { defaultPresentation } from './message-presentation.js';

/**
 * Which presentation the room draws. An explicit choice (tests, previews) beats a valid host, which beats the frame URL
 * (`?presentation=v2|classic`, a link and acceptance entry), which beats the default, classic. The host is the Café that
 * opened the room: its interface version reaches the room through the appearance bridge, and the room has no switch of its
 * own.
 */
export function resolveRoomPresentation(input: {
  readonly explicit: 'v2' | 'classic' | undefined;
  readonly host: 'v2' | 'classic' | undefined;
  readonly search: string;
}): 'v2' | 'classic' {
  return input.explicit ?? input.host ?? defaultPresentation(input.search);
}

export function useRoomPresentation(explicit?: 'v2' | 'classic'): 'v2' | 'classic' {
  const store = hostAppearance();
  // The Client is rendered in the browser only (createRoot, no hydration), so the server snapshot is the same read: a
  // string render (tests, previews) sees what the host said.
  const read = () => store.getState().presentation;
  const host = useSyncExternalStore(store.subscribe, read, read);
  return resolveRoomPresentation({
    explicit,
    host,
    search: typeof location === 'undefined' ? '' : location.search,
  });
}
