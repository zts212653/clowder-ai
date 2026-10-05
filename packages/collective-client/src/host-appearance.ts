import {
  COLLECTIVE_APPEARANCE_ROLES,
  type CollectiveAppearanceRole,
  type CollectiveAppearanceRoles,
  collectiveHostAppearanceSchema,
} from '@cat-cafe/shared';

import { readableInkOn } from './readable-ink.js';

/**
 * F322 B — host appearance bridge v1, the room's side.
 *
 * Without a valid host (opened alone, or the host has not spoken) the room is classic, light and cocoa: its own CSS tokens,
 * `data-theme="light"`, and no switch of its own. It never follows the OS into dark — web's dark tokens are keyed on
 * `data-theme`, and the room sets that only on a host's say-so.
 *
 * A host message is believed only if it comes from the exact parent window at the exact host origin, parses strictly, names
 * the current frame generation (the one the world-directory handshake minted, observed here read-only) and is newer than the
 * last one of that generation. Anything else leaves the room exactly as it was. A new generation (the world-directory
 * handshake runs again) fences out the old one and restarts the numbering; what is shown stays until the new generation
 * speaks, so a re-handshake inside one document does not flash the defaults. A reloaded frame or another Service is a new
 * document, and a new document starts from the defaults.
 */
export const ROOM_ROLE_VARIABLES = {
  canvas: '--console-card-bg',
  surface: '--cafe-surface',
  sunken: '--cafe-surface-sunken',
  text: '--cafe-text',
  textMuted: '--cafe-text-muted',
  accent: '--cafe-accent',
  humanPrimary: '--human-primary',
  humanSurface: '--human-surface',
  humanName: '--human-name',
} as const satisfies Record<CollectiveAppearanceRole, string>;

/** Derived in the room from `humanPrimary`, never sent: see `paint`. */
export const HUMAN_INK_VARIABLE = '--human-ink';

export interface HostAppearanceState {
  /** What the host says; `undefined` while no host has spoken (the frame URL or the default decides then). */
  readonly presentation: 'classic' | 'v2' | undefined;
  readonly scheme: 'light' | 'dark';
  readonly roles: CollectiveAppearanceRoles | undefined;
}

const DIRECT: HostAppearanceState = { presentation: undefined, scheme: 'light', roles: undefined };

export interface HostAppearanceStore {
  readonly getState: () => HostAppearanceState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly observeGeneration: (bridgeId: string) => void;
  readonly receive: (event: { readonly origin: string; readonly source: unknown; readonly data: unknown }) => boolean;
  readonly dispose: () => void;
}

export function createHostAppearance(input: {
  readonly root: HTMLElement;
  readonly hostOrigin: string | undefined;
  readonly parent: unknown;
  /** Where `message` events arrive; the window in the browser. */
  readonly target?: EventTarget;
}): HostAppearanceStore {
  const listeners = new Set<() => void>();
  let state = DIRECT;
  let generation: string | undefined;
  let revision = 0;

  const paint = (next: HostAppearanceState) => {
    input.root.setAttribute('data-theme', next.scheme);
    input.root.style.colorScheme = next.scheme;
    for (const role of COLLECTIVE_APPEARANCE_ROLES) {
      const variable = ROOM_ROLE_VARIABLES[role];
      if (next.roles) input.root.style.setProperty(variable, next.roles[role]);
      else input.root.style.removeProperty(variable);
    }
    // Not a role on the wire: the ink of an initial on the human-colour disc is derived here from the primary the host
    // said, so the two cannot disagree. Without a host the CSS default (for the default primary) stands.
    const ink = next.roles ? readableInkOn(next.roles.humanPrimary) : undefined;
    if (ink) input.root.style.setProperty(HUMAN_INK_VARIABLE, ink);
    else input.root.style.removeProperty(HUMAN_INK_VARIABLE);
  };
  const set = (next: HostAppearanceState) => {
    state = next;
    paint(next);
    for (const listener of listeners) listener();
  };
  paint(state);

  const receive: HostAppearanceStore['receive'] = (event) => {
    if (!input.hostOrigin || event.origin !== input.hostOrigin || event.source !== input.parent) return false;
    if (generation === undefined) return false;
    const parsed = collectiveHostAppearanceSchema.safeParse(event.data);
    if (!parsed.success) return false;
    const message = parsed.data;
    if (message.bridgeId !== generation || message.appearanceRevision <= revision) return false;
    revision = message.appearanceRevision;
    set({ presentation: message.presentation, scheme: message.resolvedScheme, roles: message.roles });
    return true;
  };

  const onMessage = (event: Event) => {
    const { origin, source, data } = event as MessageEvent<unknown>;
    receive({ origin, source, data });
  };
  if (input.hostOrigin) input.target?.addEventListener('message', onMessage);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    observeGeneration(bridgeId) {
      if (bridgeId === generation) return;
      generation = bridgeId;
      revision = 0;
    },
    receive,
    dispose() {
      input.target?.removeEventListener('message', onMessage);
      listeners.clear();
    },
  };
}

/** The host named in the frame URL, only when embedded and only as an exact http(s) origin. */
export function resolveHostOrigin(search: string, embedded: boolean): string | undefined {
  if (!embedded) return undefined;
  const candidate = new URLSearchParams(search).get('hostOrigin');
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === candidate ? candidate : undefined;
  } catch {
    return undefined;
  }
}

let current: HostAppearanceStore | undefined;
const idle: HostAppearanceStore = {
  getState: () => DIRECT,
  subscribe: () => () => undefined,
  observeGeneration: () => undefined,
  receive: () => false,
  dispose: () => undefined,
};

/** Start listening for the host. Called once, before the first render, from the Client's entry. */
export function startHostAppearance(win: Window = window, root: HTMLElement = document.documentElement) {
  current?.dispose();
  const hostOrigin = resolveHostOrigin(win.location.search, win.parent !== win);
  current = createHostAppearance({ root, hostOrigin, parent: win.parent, target: win });
  return current;
}

export const hostAppearance = (): HostAppearanceStore => current ?? idle;

/** The world-directory handshake minted a frame generation: the host's appearance is fenced to it. */
export const observeHostAppearanceGeneration = (bridgeId: string) => hostAppearance().observeGeneration(bridgeId);
