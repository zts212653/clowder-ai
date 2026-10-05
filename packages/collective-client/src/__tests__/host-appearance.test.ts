// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIVE_APPEARANCE_ROLES, type CollectiveHostAppearance } from '@cat-cafe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHostAppearance,
  type HostAppearanceStore,
  HUMAN_INK_VARIABLE,
  ROOM_ROLE_VARIABLES,
  resolveHostOrigin,
} from '../host-appearance.js';
import { inkContrast, readableInkOn } from '../readable-ink.js';

/**
 * F322 B — the room's side of the appearance bridge. What the room is allowed to believe about the Café's look:
 *
 * - With no valid host (opened alone, or the host has said nothing yet) the room is classic, light and cocoa. It does not
 *   follow the OS into dark and it has no switch of its own; `?presentation=` is a link/acceptance entry (see
 *   `defaultPresentation`), not a host.
 * - A host message is believed only if it comes from the exact parent window at the exact host origin, parses strictly, names
 *   the current frame generation (the one the world-directory handshake minted) and is newer than the last one. Anything else
 *   leaves the room exactly as it was: not reset to a constant, not partially applied.
 * - A new generation (the handshake runs again) fences out the old one and restarts the numbering; a new document (reload,
 *   another Service) starts from the defaults.
 */
const HOST = 'https://cafe.example.test';
const roles = {
  canvas: '#1c1815',
  surface: '#26211d',
  sunken: '#302a25',
  text: '#f1e9e1',
  textMuted: '#b3a79c',
  accent: '#d4a984',
  humanPrimary: '#a88470',
  humanSurface: '#4a3a31',
  humanName: '#f3e4d8',
} as const;
const message = (over: Partial<CollectiveHostAppearance> = {}): CollectiveHostAppearance => ({
  type: 'collective:host-appearance',
  v: 1,
  bridgeId: 'bridge_aaaaaaaa',
  appearanceRevision: 1,
  presentation: 'v2',
  resolvedScheme: 'dark',
  roles,
  ...over,
});

describe('the room appearance from the host', () => {
  let root: HTMLElement;
  let parent: object;
  let store: HostAppearanceStore;
  const deliver = (data: unknown, over: { origin?: string; source?: unknown } = {}) =>
    store.receive({ origin: over.origin ?? HOST, source: 'source' in over ? over.source : parent, data });
  const roleValue = (role: keyof typeof roles) => root.style.getPropertyValue(ROOM_ROLE_VARIABLES[role]);
  const cleared = () => COLLECTIVE_APPEARANCE_ROLES.every((role) => roleValue(role) === '');

  beforeEach(() => {
    root = document.createElement('html');
    parent = {};
    store = createHostAppearance({ root, hostOrigin: HOST, parent });
  });
  afterEach(() => store.dispose());

  it('is classic, light and cocoa until a host says otherwise, and never follows the OS into dark', () => {
    const matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal('matchMedia', matchMedia);
    const fresh = createHostAppearance({
      root: document.createElement('html'),
      hostOrigin: undefined,
      parent: undefined,
    });

    expect(fresh.getState()).toEqual({ presentation: undefined, scheme: 'light', roles: undefined });
    expect(matchMedia).not.toHaveBeenCalled();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(cleared()).toBe(true);
    vi.unstubAllGlobals();
    fresh.dispose();
  });

  it('believes a message from the exact parent at the exact host origin for the current generation, and paints it', () => {
    const changes = vi.fn();
    store.subscribe(changes);
    store.observeGeneration('bridge_aaaaaaaa');
    changes.mockClear();

    expect(deliver(message())).toBe(true);

    expect(store.getState()).toEqual({ presentation: 'v2', scheme: 'dark', roles });
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    for (const role of COLLECTIVE_APPEARANCE_ROLES) expect(roleValue(role), role).toBe(roles[role]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('takes the next revision of the same generation and refuses an equal or older one', () => {
    store.observeGeneration('bridge_aaaaaaaa');
    deliver(message({ appearanceRevision: 2 }));

    expect(deliver(message({ appearanceRevision: 2, resolvedScheme: 'light', presentation: 'classic' }))).toBe(false);
    expect(deliver(message({ appearanceRevision: 1, resolvedScheme: 'light', presentation: 'classic' }))).toBe(false);
    expect(store.getState()).toMatchObject({ presentation: 'v2', scheme: 'dark' });

    expect(deliver(message({ appearanceRevision: 3, resolvedScheme: 'light', presentation: 'classic' }))).toBe(true);
    expect(store.getState()).toMatchObject({ presentation: 'classic', scheme: 'light' });
  });

  it('refuses a message from the wrong place, the wrong time or the wrong shape, and stays exactly as it was', () => {
    store.observeGeneration('bridge_aaaaaaaa');
    deliver(message({ appearanceRevision: 5 }));
    const before = store.getState();
    const html = root.outerHTML;
    const bad: Array<[string, boolean]> = [
      ['wrong origin', deliver(message({ appearanceRevision: 6 }), { origin: 'https://evil.example.test' })],
      ['wrong source', deliver(message({ appearanceRevision: 6 }), { source: {} })],
      ['no source', deliver(message({ appearanceRevision: 6 }), { source: null })],
      ['other generation', deliver(message({ appearanceRevision: 6, bridgeId: 'bridge_bbbbbbbb' }))],
      ['unknown version', deliver({ ...message({ appearanceRevision: 6 }), v: 2 })],
      ['extra key', deliver({ ...message({ appearanceRevision: 6 }), displayName: '阿宪' })],
      ['css string', deliver({ ...message({ appearanceRevision: 6 }), roles: { ...roles, text: 'var(--x)' } })],
      ['missing role', deliver({ ...message({ appearanceRevision: 6 }), roles: { ...roles, text: undefined } })],
      ['not an object', deliver('collective:host-appearance')],
      ['null', deliver(null)],
    ];

    for (const [label, accepted] of bad) expect(accepted, label).toBe(false);
    expect(store.getState()).toBe(before);
    expect(root.outerHTML).toBe(html);
  });

  it('derives the ink of an initial on the human-colour disc from the primary the host said, and follows it', () => {
    store.observeGeneration('bridge_aaaaaaaa');
    const ink = () => root.style.getPropertyValue(HUMAN_INK_VARIABLE);
    expect(ink()).toBe('');

    deliver(message({ appearanceRevision: 1, roles: { ...roles, humanPrimary: '#c66846' } }));
    expect(ink()).toBe(readableInkOn('#c66846'));
    expect(inkContrast(ink(), '#c66846')).toBeGreaterThanOrEqual(4.5);

    deliver(message({ appearanceRevision: 2, roles: { ...roles, humanPrimary: '#f2e6da' } }));
    expect(ink()).toBe('#000000');
    deliver(message({ appearanceRevision: 3, roles: { ...roles, humanPrimary: '#3b2a20' } }));
    expect(ink()).toBe('#ffffff');
    for (const primary of ['#c66846', '#f2e6da', '#3b2a20']) {
      expect(inkContrast(readableInkOn(primary) as string, primary), primary).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('leaves the ink alone when a message is refused, and gives it back to the CSS default without a host', () => {
    store.observeGeneration('bridge_aaaaaaaa');
    deliver(message({ appearanceRevision: 1, roles: { ...roles, humanPrimary: '#c66846' } }));
    const accepted = root.style.getPropertyValue(HUMAN_INK_VARIABLE);
    expect(accepted).toBe(readableInkOn('#c66846'));

    deliver(message({ appearanceRevision: 1, roles: { ...roles, humanPrimary: '#f2e6da' } }));
    deliver(message({ appearanceRevision: 2, roles: { ...roles, humanPrimary: '#f2e6da' } }), {
      origin: 'https://evil.example.test',
    });
    expect(root.style.getPropertyValue(HUMAN_INK_VARIABLE)).toBe(accepted);

    const fresh = createHostAppearance({
      root: document.createElement('html'),
      hostOrigin: undefined,
      parent: undefined,
    });
    expect(fresh.getState().roles).toBeUndefined();
    fresh.dispose();
  });

  it('believes nothing before the handshake has named a generation', () => {
    expect(deliver(message())).toBe(false);
    expect(store.getState().presentation).toBeUndefined();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(cleared()).toBe(true);
  });

  it('fences out the old generation on a new one and restarts the numbering, keeping what is shown until the new one speaks', () => {
    store.observeGeneration('bridge_aaaaaaaa');
    deliver(message({ appearanceRevision: 4 }));
    const changes = vi.fn();
    store.subscribe(changes);

    store.observeGeneration('bridge_bbbbbbbb');

    // A re-handshake inside one document is not a new look: nothing flashes back to the defaults.
    expect(changes).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ presentation: 'v2', scheme: 'dark', roles });
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(roleValue('humanSurface')).toBe(roles.humanSurface);
    // The old generation can no longer move the room, whatever its revision.
    expect(deliver(message({ appearanceRevision: 9, presentation: 'classic', resolvedScheme: 'light' }))).toBe(false);
    expect(store.getState()).toMatchObject({ presentation: 'v2', scheme: 'dark' });
    // The new generation starts again at 1.
    expect(deliver(message({ bridgeId: 'bridge_bbbbbbbb', appearanceRevision: 1, presentation: 'classic' }))).toBe(
      true,
    );
    expect(store.getState().presentation).toBe('classic');
  });

  it('does not notify or renumber when the same generation is observed again', () => {
    store.observeGeneration('bridge_aaaaaaaa');
    deliver(message({ appearanceRevision: 3 }));
    const changes = vi.fn();
    store.subscribe(changes);

    store.observeGeneration('bridge_aaaaaaaa');

    expect(changes).not.toHaveBeenCalled();
    expect(deliver(message({ appearanceRevision: 3, presentation: 'classic' }))).toBe(false);
    expect(store.getState().presentation).toBe('v2');
  });

  it('is deaf when it is not embedded: no host origin means no host', () => {
    const alone = createHostAppearance({
      root: document.createElement('html'),
      hostOrigin: undefined,
      parent: undefined,
    });
    alone.observeGeneration('bridge_aaaaaaaa');

    expect(alone.receive({ origin: HOST, source: undefined, data: message() })).toBe(false);
    expect(alone.getState().presentation).toBeUndefined();
    alone.dispose();
  });

  it('listens to the window only when embedded, and stops when disposed', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');

    const alone = createHostAppearance({
      root: document.createElement('html'),
      hostOrigin: undefined,
      parent: undefined,
      target,
    });
    expect(add).not.toHaveBeenCalled();
    alone.dispose();

    const embedded = createHostAppearance({ root: document.createElement('html'), hostOrigin: HOST, parent, target });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe('message');
    embedded.dispose();
    expect(remove).toHaveBeenCalledWith('message', add.mock.calls[0][1]);
  });

  it('hears a real window message event, with the source and origin the browser would give it', () => {
    const target = new EventTarget();
    const listening = createHostAppearance({ root: document.createElement('html'), hostOrigin: HOST, parent, target });
    listening.observeGeneration('bridge_aaaaaaaa');

    target.dispatchEvent(Object.assign(new Event('message'), { origin: HOST, source: parent, data: message() }));

    expect(listening.getState()).toMatchObject({ presentation: 'v2', scheme: 'dark' });
    listening.dispose();
  });
});

describe('who the host is', () => {
  it('is the exact http(s) origin the frame URL names, and only when embedded', () => {
    expect(resolveHostOrigin('?hostOrigin=https%3A%2F%2Fcafe.example.test', true)).toBe('https://cafe.example.test');
    expect(resolveHostOrigin('?hostOrigin=http%3A%2F%2Flocalhost%3A3003', true)).toBe('http://localhost:3003');
    expect(resolveHostOrigin('?hostOrigin=https%3A%2F%2Fcafe.example.test', false)).toBeUndefined();
    expect(resolveHostOrigin('', true)).toBeUndefined();
  });

  it('refuses anything that is not already a bare origin', () => {
    for (const candidate of [
      'https://cafe.example.test/',
      'https://cafe.example.test/path',
      'https://cafe.example.test?x=1',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      '*',
    ]) {
      expect(resolveHostOrigin(`?hostOrigin=${encodeURIComponent(candidate)}`, true), candidate).toBeUndefined();
    }
  });
});

describe('the closed role set and the room rules that consume it', () => {
  const stylesDirectory = join(import.meta.dirname, '../styles');
  const stylesheet = (name: string) => readFileSync(join(stylesDirectory, name), 'utf8');
  const variablesUsed = (css: string) => new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((match) => match[1]));

  it('maps each role to one room variable, and the table covers exactly the closed role set', () => {
    expect(Object.keys(ROOM_ROLE_VARIABLES).sort()).toEqual([...COLLECTIVE_APPEARANCE_ROLES].sort());
    expect(new Set(Object.values(ROOM_ROLE_VARIABLES)).size).toBe(COLLECTIVE_APPEARANCE_ROLES.length);
  });

  it('has no dead role: every room variable a role sets is read by a room rule', () => {
    // Every stylesheet of the room, not a hand-kept list: a role's only reader can be any of them (`--cafe-surface` is read by
    // the onboarding card, and was once read by the nameplate's initial), and a list would call a live role dead or the
    // reverse.
    const used = new Set<string>();
    for (const file of readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'))) {
      for (const name of variablesUsed(stylesheet(file))) used.add(name);
    }
    for (const role of COLLECTIVE_APPEARANCE_ROLES) expect(used.has(ROOM_ROLE_VARIABLES[role]), role).toBe(true);
  });

  it('has no unlisted dependency: the human presentation reads only colour variables that are roles or layout', () => {
    const css = stylesheet('channel-message.css');
    const human = css.slice(css.indexOf('/* F322 B segment 1 (human message), shared-room half'));
    // The ink on the human-colour disc is the one derived variable: not a role on the wire, set from `humanPrimary`.
    const allowed = new Set<string>([...Object.values(ROOM_ROLE_VARIABLES), HUMAN_INK_VARIABLE]);
    const unlisted = [...variablesUsed(human)].filter((name) => !allowed.has(name));

    expect(human.length).toBeGreaterThan(500);
    expect(unlisted).toEqual([]);
    // A room with no host has no derived value: the CSS has to define the one for its default primary.
    expect(human).toMatch(new RegExp(`${HUMAN_INK_VARIABLE}:\\s*#000000;`));
  });
});
