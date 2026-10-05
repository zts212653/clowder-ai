import { z } from 'zod';

/**
 * F322 B — host appearance bridge v1 (`collective:host-appearance`): how the Café's look reaches the shared room.
 *
 * The room runs in its own frame and cannot read the Café's theme, interface version or colour configuration, so the host
 * says them. The message is volatile display state: it carries no identity, no configuration tree, no names or avatars, no
 * CSS strings, selectors or URLs, and nothing about work, membership or permissions. It is fenced to one frame generation
 * (`bridgeId`, the same one the world-directory handshake mints) and ordered by its own monotonic `appearanceRevision`.
 *
 * The role set is closed: exactly the colours the room's human presentation paints and the page it sits on. A role is
 * added here only together with the room rule that consumes it; a colour is the opaque sRGB value the Café paints, `#rrggbb`.
 */
export const COLLECTIVE_APPEARANCE_ROLES = [
  'canvas',
  'surface',
  'sunken',
  'text',
  'textMuted',
  'accent',
  'humanPrimary',
  'humanSurface',
  'humanName',
] as const;

const resolvedColor = z.string().regex(/^#[0-9a-f]{6}$/);

export const collectiveAppearanceRolesSchema = z
  .object({
    /** The page the message column sits on. */
    canvas: resolvedColor,
    /** The surface a person's initial sits on in the plate. */
    surface: resolvedColor,
    /** The sunken panel a code block uses, also inside the human block. */
    sunken: resolvedColor,
    /** Body text, including the text in the human block. */
    text: resolvedColor,
    /** Secondary text: the time under a message. */
    textMuted: resolvedColor,
    /** Focus ring and links. */
    accent: resolvedColor,
    /** The person's avatar disc in the plate. */
    humanPrimary: resolvedColor,
    /** The human block and the nameplate's fill. */
    humanSurface: resolvedColor,
    /** The name on the plate. */
    humanName: resolvedColor,
  })
  .strict();

export const collectiveHostAppearanceSchema = z
  .object({
    type: z.literal('collective:host-appearance'),
    v: z.literal(1),
    bridgeId: z.string().min(8).max(120),
    appearanceRevision: z.number().int().positive(),
    presentation: z.enum(['classic', 'v2']),
    resolvedScheme: z.enum(['light', 'dark']),
    roles: collectiveAppearanceRolesSchema,
  })
  .strict();

export type CollectiveAppearanceRole = (typeof COLLECTIVE_APPEARANCE_ROLES)[number];
export type CollectiveAppearanceRoles = z.infer<typeof collectiveAppearanceRolesSchema>;
export type CollectiveHostAppearance = z.infer<typeof collectiveHostAppearanceSchema>;
