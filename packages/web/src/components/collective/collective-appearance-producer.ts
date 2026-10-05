import {
  COLLECTIVE_APPEARANCE_ROLES,
  type CollectiveAppearanceRole,
  type CollectiveAppearanceRoles,
  type CollectiveHostAppearance,
  collectiveHostAppearanceSchema,
} from '@cat-cafe/shared';

/**
 * F322 B — host appearance bridge v1, producer side: what the Café says about its own look to the shared room.
 *
 * Every colour is read from the Café's own resolved tokens, the F056 output the page is painted with (theme, tuned
 * surfaces and the co-creator colour all arrive through those tokens); nothing is recomputed or re-derived here, and
 * nothing of the configuration (names, avatars, the config tree) is read. When a role cannot be resolved to an opaque
 * colour the producer says nothing, so the room keeps its own defaults instead of being told a partial or invented look.
 */
export const APPEARANCE_ROLE_SOURCES = {
  canvas: '--cafe-surface-canvas',
  surface: '--cafe-surface',
  sunken: '--cafe-surface-sunken',
  text: '--cafe-text',
  textMuted: '--cafe-text-muted',
  accent: '--cafe-accent',
  humanPrimary: '--color-cocreator-primary',
  humanSurface: '--color-cocreator-surface',
  humanName: '--color-cocreator-text',
} as const satisfies Record<CollectiveAppearanceRole, string>;

/** Resolve one Café CSS variable to an opaque `#rrggbb`, or `undefined` when it cannot be. */
export type ResolveHostColor = (cssVariable: string) => string | undefined;

export interface HostAppearance {
  readonly presentation: 'classic' | 'v2';
  readonly resolvedScheme: 'light' | 'dark';
  readonly roles: CollectiveAppearanceRoles;
}

const OPAQUE_HEX = /^#[0-9a-f]{6}$/;

export function readHostAppearance(input: {
  readonly presentation: 'classic' | 'v2';
  readonly scheme: 'light' | 'dark';
  readonly resolveColor: ResolveHostColor;
}): HostAppearance | undefined {
  const roles: Partial<Record<CollectiveAppearanceRole, string>> = {};
  for (const role of COLLECTIVE_APPEARANCE_ROLES) {
    const value = input.resolveColor(APPEARANCE_ROLE_SOURCES[role]);
    if (value === undefined || !OPAQUE_HEX.test(value)) return undefined;
    roles[role] = value;
  }
  return {
    presentation: input.presentation,
    resolvedScheme: input.scheme,
    roles: roles as CollectiveAppearanceRoles,
  };
}

/** A canvas pixel as the opaque `#rrggbb` it promises; translucent pixels have no honest single-colour form. */
export function hexFromRgba([r, g, b, a]: readonly [number, number, number, number]): string | undefined {
  if (a !== 255) return undefined;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Two parent colours that differ in every channel: the probe sits under each in turn. `color` is an inherited property, so
 * `color: var(--token)` with a token that is missing, not a colour or part of a cycle does not fail — it computes to
 * whatever the parent's colour is. Reading it under two different parents and keeping the value only when both agree tells
 * a real token (the same colour either way) from an inherited one (it follows the parent).
 */
const INHERIT_SENTINELS = ['#010203', '#fdfcfb'] as const;

/**
 * Resolve a Café token with the browser's own colour engine: let the page compute `color: var(--token)` (whatever colour
 * space the token is written in) and read the sRGB pixel back through a 1×1 canvas. A token the page cannot resolve to a
 * colour of its own (missing, invalid, circular, `currentcolor`) is `undefined`, never the colour it would inherit.
 */
export function resolveColorFromDocument(doc: Document = document): ResolveHostColor {
  const holder = doc.createElement('span');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden';
  const probe = doc.createElement('span');
  holder.append(probe);
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const pixelUnder = (inherited: string, cssVariable: string): string | undefined => {
    holder.style.color = inherited;
    probe.style.color = '';
    probe.style.color = `var(${cssVariable})`;
    const computed = doc.defaultView?.getComputedStyle(probe).color;
    if (!computed || !context) return undefined;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = computed;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return hexFromRgba([r, g, b, a]);
  };
  return (cssVariable) => {
    if (!context) return undefined;
    doc.body.append(holder);
    try {
      const [first, second] = INHERIT_SENTINELS.map((inherited) => pixelUnder(inherited, cssVariable));
      return first !== undefined && first === second ? first : undefined;
    } finally {
      holder.remove();
    }
  };
}

/**
 * Numbers what is said, one frame generation (`bridgeId`) at a time: the first message of a generation is revision 1, a
 * look that did not change is not said again, a change is one higher, and a new generation restarts.
 */
export function createAppearanceSequencer() {
  let bridgeId: string | undefined;
  let revision = 0;
  let lastKey: string | undefined;
  return {
    next(nextBridgeId: string, appearance: HostAppearance): CollectiveHostAppearance | undefined {
      if (nextBridgeId !== bridgeId) {
        bridgeId = nextBridgeId;
        revision = 0;
        lastKey = undefined;
      }
      const key = JSON.stringify(appearance);
      if (key === lastKey) return undefined;
      lastKey = key;
      revision += 1;
      return collectiveHostAppearanceSchema.parse({
        type: 'collective:host-appearance',
        v: 1,
        bridgeId: nextBridgeId,
        appearanceRevision: revision,
        ...appearance,
      });
    },
  };
}
