import { z } from 'zod';

/** F311 owns the Program's user-supplied name, independently of the target owner's asset contents. */
export const evolutionProgramDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 &&
          character.charCodeAt(0) !== 127 &&
          character !== '\u2028' &&
          character !== '\u2029',
      ),
    'Program name must be a single readable line',
  );

/** Live, workspace-fenced conversation context; never persisted as a Program or asset name. */
export const evolutionProgramOriginV1Schema = z
  .object({
    threadId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_-]+$/),
    title: z.string().trim().min(1).max(200),
    /** Authenticated creation actor; a contact for continuation, not a claim of current task custody. */
    createdByCatId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
  })
  .strict();
export type EvolutionProgramOriginV1 = z.infer<typeof evolutionProgramOriginV1Schema>;

export function evolutionProgramTitle(
  program: { programId: string; displayName?: string },
  origin?: EvolutionProgramOriginV1,
): string {
  return program.displayName ?? (origin ? `来自「${origin.title}」` : '未命名项目');
}
