import { COLLECTIVE_APPEARANCE_ROLES, collectiveHostAppearanceSchema } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';

import {
  APPEARANCE_ROLE_SOURCES,
  createAppearanceSequencer,
  hexFromRgba,
  readHostAppearance,
} from '../collective-appearance-producer';

/**
 * F322 B — what the Café says about its own look to the shared room (host appearance bridge v1, producer side).
 *
 * Values are read from the Café's own resolved tokens (the F056 output the page paints), never recomputed here. When any
 * role cannot be resolved to an opaque colour the producer says nothing at all: the room keeps its own defaults (classic,
 * light, cocoa) rather than being told a partial or invented look.
 */
const values: Record<string, string> = {
  '--cafe-surface-canvas': '#fbf7f2',
  '--cafe-surface': '#f6efe7',
  '--cafe-surface-sunken': '#ece3d9',
  '--cafe-text': '#2a211b',
  '--cafe-text-muted': '#6c5f55',
  '--cafe-accent': '#7a5a43',
  '--color-cocreator-primary': '#8c6f5a',
  '--color-cocreator-surface': '#e3d2c3',
  '--color-cocreator-text': '#2c1f1f',
};
const resolveColor = (variable: string) => values[variable];

describe('reading the Café appearance', () => {
  it('reads each room role from one Café token, and the table covers exactly the closed role set', () => {
    expect(Object.keys(APPEARANCE_ROLE_SOURCES).sort()).toEqual([...COLLECTIVE_APPEARANCE_ROLES].sort());
    expect(new Set(Object.values(APPEARANCE_ROLE_SOURCES)).size).toBe(COLLECTIVE_APPEARANCE_ROLES.length);
  });

  it('returns the resolved colours with the version and scheme it was asked for', () => {
    expect(readHostAppearance({ presentation: 'v2', scheme: 'dark', resolveColor })).toEqual({
      presentation: 'v2',
      resolvedScheme: 'dark',
      roles: {
        canvas: '#fbf7f2',
        surface: '#f6efe7',
        sunken: '#ece3d9',
        text: '#2a211b',
        textMuted: '#6c5f55',
        accent: '#7a5a43',
        humanPrimary: '#8c6f5a',
        humanSurface: '#e3d2c3',
        humanName: '#2c1f1f',
      },
    });
  });

  it('says nothing when any one role cannot be resolved, instead of sending a partial or invented look', () => {
    for (const variable of Object.values(APPEARANCE_ROLE_SOURCES)) {
      const missing = (name: string) => (name === variable ? undefined : values[name]);
      expect(
        readHostAppearance({ presentation: 'classic', scheme: 'light', resolveColor: missing }),
        variable,
      ).toBeUndefined();
    }
  });

  it('refuses a value that is not the opaque #rrggbb it promises, rather than passing it on', () => {
    for (const bad of ['rgba(0, 0, 0, 0.5)', '#FFF', 'oklch(0.5 0.1 20)', '', 'red']) {
      const resolve = (name: string) => (name === '--cafe-text' ? bad : values[name]);
      expect(
        readHostAppearance({ presentation: 'classic', scheme: 'light', resolveColor: resolve }),
        bad,
      ).toBeUndefined();
    }
  });
});

describe('the canvas read back as a colour', () => {
  it('writes opaque sRGB as lower-case #rrggbb', () => {
    expect(hexFromRgba([251, 247, 242, 255])).toBe('#fbf7f2');
    expect(hexFromRgba([0, 0, 0, 255])).toBe('#000000');
    expect(hexFromRgba([255, 255, 255, 255])).toBe('#ffffff');
  });

  it('refuses anything translucent: a role is an opaque colour or nothing', () => {
    expect(hexFromRgba([10, 20, 30, 254])).toBeUndefined();
    expect(hexFromRgba([10, 20, 30, 0])).toBeUndefined();
  });
});

describe('numbering what is said, one frame generation at a time', () => {
  const appearance = readHostAppearance({ presentation: 'v2', scheme: 'light', resolveColor });
  if (!appearance) throw new Error('fixture');
  const dark = { ...appearance, resolvedScheme: 'dark' as const };

  it('starts a generation at revision 1 and produces a message the schema accepts', () => {
    const sequencer = createAppearanceSequencer();
    const first = sequencer.next('bridge_aaaaaaaa', appearance);

    expect(first).toMatchObject({
      type: 'collective:host-appearance',
      v: 1,
      bridgeId: 'bridge_aaaaaaaa',
      appearanceRevision: 1,
    });
    expect(collectiveHostAppearanceSchema.parse(first)).toEqual(first);
  });

  it('says nothing again when nothing changed, and numbers a change one higher', () => {
    const sequencer = createAppearanceSequencer();
    sequencer.next('bridge_aaaaaaaa', appearance);

    expect(sequencer.next('bridge_aaaaaaaa', appearance)).toBeUndefined();
    expect(sequencer.next('bridge_aaaaaaaa', dark)?.appearanceRevision).toBe(2);
    expect(sequencer.next('bridge_aaaaaaaa', dark)).toBeUndefined();
    expect(sequencer.next('bridge_aaaaaaaa', appearance)?.appearanceRevision).toBe(3);
  });

  it('restarts at 1 for a new generation, whatever the old one reached', () => {
    const sequencer = createAppearanceSequencer();
    sequencer.next('bridge_aaaaaaaa', appearance);
    sequencer.next('bridge_aaaaaaaa', dark);

    expect(sequencer.next('bridge_bbbbbbbb', dark)).toMatchObject({
      bridgeId: 'bridge_bbbbbbbb',
      appearanceRevision: 1,
    });
  });
});
