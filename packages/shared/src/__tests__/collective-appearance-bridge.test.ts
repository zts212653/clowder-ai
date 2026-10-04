import { describe, expect, it } from 'vitest';
import {
  COLLECTIVE_APPEARANCE_ROLES,
  collectiveAppearanceRolesSchema,
  collectiveHostAppearanceSchema,
} from '../index.js';

/**
 * F322 B — the Café's look as the shared room sees it (host appearance bridge v1, `collective:host-appearance`).
 *
 * What may cross: the interface version, the resolved light / dark scheme and a closed set of already-resolved colours — the
 * ones the room's human presentation actually paints (human block and plate, the page it sits on, its text). What may not:
 * the config tree, identities, names, avatars, CSS strings, selectors, URLs or any key outside the set. A colour is the
 * opaque sRGB value the Café paints, written `#rrggbb`.
 */
const roles = {
  canvas: '#fbf7f2',
  surface: '#f6efe7',
  sunken: '#ece3d9',
  text: '#2a211b',
  textMuted: '#6c5f55',
  accent: '#7a5a43',
  humanPrimary: '#8c6f5a',
  humanSurface: '#e3d2c3',
  humanName: '#2c1f1f',
} as const;

const message = {
  type: 'collective:host-appearance',
  v: 1,
  bridgeId: 'bridge_12345678',
  appearanceRevision: 1,
  presentation: 'v2',
  resolvedScheme: 'light',
  roles,
} as const;

describe('collective host appearance bridge schema', () => {
  it('carries the interface version, the resolved scheme and the closed set of resolved colours', () => {
    expect(collectiveHostAppearanceSchema.parse(message)).toEqual(message);
    expect(
      collectiveHostAppearanceSchema.parse({ ...message, presentation: 'classic', resolvedScheme: 'dark' }),
    ).toMatchObject({ presentation: 'classic', resolvedScheme: 'dark' });
  });

  it('lists the role set once: the constant and the schema cannot drift apart', () => {
    expect([...COLLECTIVE_APPEARANCE_ROLES].sort()).toEqual(Object.keys(collectiveAppearanceRolesSchema.shape).sort());
    expect([...COLLECTIVE_APPEARANCE_ROLES].sort()).toEqual(Object.keys(roles).sort());
  });

  it('refuses a key outside the message, and a role outside the set', () => {
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, humanDisplayName: '阿宪' })).toThrow();
    expect(() =>
      collectiveHostAppearanceSchema.parse({ ...message, avatarUrl: 'https://example.test/a.png' }),
    ).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, css: ':root{--x:1}' })).toThrow();
    expect(() =>
      collectiveHostAppearanceSchema.parse({ ...message, roles: { ...roles, 'custom-prop': '#000000' } }),
    ).toThrow();
    expect(() =>
      collectiveHostAppearanceSchema.parse({ ...message, roles: { ...roles, '--cafe-text': '#000000' } }),
    ).toThrow();
  });

  it('refuses an incomplete role set instead of filling the gap with a constant', () => {
    for (const role of COLLECTIVE_APPEARANCE_ROLES) {
      const { [role]: _omitted, ...rest } = roles;
      expect(() => collectiveHostAppearanceSchema.parse({ ...message, roles: rest }), role).toThrow();
    }
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, roles: undefined })).toThrow();
  });

  it('accepts a colour only as the opaque resolved value #rrggbb', () => {
    const bad = [
      '#FBF7F2',
      '#fbf7f2ff',
      '#fff',
      'fbf7f2',
      'rgb(1, 2, 3)',
      'oklch(0.85 0.018 58)',
      'var(--cafe-text)',
      'url(https://example.test/x.png)',
      'red',
      '#fbf7f2; background: url(x)',
      ' #fbf7f2',
      '',
    ];
    for (const value of bad) {
      expect(
        () => collectiveHostAppearanceSchema.parse({ ...message, roles: { ...roles, text: value } }),
        value,
      ).toThrow();
    }
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, roles: { ...roles, text: 123456 } })).toThrow();
  });

  it('refuses a version, scheme, presentation, type or revision it does not know', () => {
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, v: 2 })).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, v: undefined })).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, type: 'collective:host-context-init' })).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, presentation: 'auto' })).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, resolvedScheme: 'system' })).toThrow();
    for (const appearanceRevision of [0, -1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => collectiveHostAppearanceSchema.parse({ ...message, appearanceRevision }),
        String(appearanceRevision),
      ).toThrow();
    }
  });

  it('is fenced to one frame generation: a bridge id of the same shape the other host messages use', () => {
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, bridgeId: 'short' })).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, bridgeId: 'b'.repeat(121) })).toThrow();
    expect(() => collectiveHostAppearanceSchema.parse({ ...message, bridgeId: undefined })).toThrow();
  });

  it('is bounded in size however it is filled', () => {
    expect(
      JSON.stringify(collectiveHostAppearanceSchema.parse({ ...message, bridgeId: 'b'.repeat(120) })).length,
    ).toBeLessThan(600);
  });
});
