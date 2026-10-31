/**
 * Zod schemas for manifest.yaml slashCommands validation — F142 Phase B
 */
import { z } from 'zod';

/** Matches /lowercase-name (1-31 chars after the slash) */
export const slashCommandNameSchema = z
  .string()
  .regex(
    /^\/[a-z][a-z0-9-]{0,30}$/,
    'Command name must start with / followed by 1-31 lowercase alphanumeric/dash chars',
  );

/** HTML tag pattern — rejects <tag> but allows standalone < or > */
const HTML_TAG_RE = /<[a-z/][^>]*>/i;

export const ManifestSlashCommandSchema = z.object({
  name: slashCommandNameSchema,
  usage: z.string().max(200).optional(),
  description: z
    .string()
    .max(200)
    .refine((s) => !HTML_TAG_RE.test(s), 'Description must be plain text (no HTML tags)'),
  surface: z.enum(['web', 'connector', 'both']).default('connector'),
  subcommands: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'Subcommand must be lowercase alphanumeric/dash'))
    .optional(),
});

export const ManifestSlashCommandsSchema = z.array(ManifestSlashCommandSchema);

export type ManifestSlashCommand = z.infer<typeof ManifestSlashCommandSchema>;
