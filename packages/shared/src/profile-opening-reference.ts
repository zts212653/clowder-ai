import { isMap, parse, parseDocument } from 'yaml';
import { z } from 'zod';

const coordinate = z
  .object({
    threadId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    messageId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  })
  .strict();
const excerpt = { text: z.string().trim().min(1).max(600), source: coordinate };
export const profileOpeningReferenceSchema = z
  .object({
    asOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const parsed = new Date(`${value}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      }),
    excerpts: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ ...excerpt, kind: z.literal('relationship') }).strict(),
          z
            .object({ ...excerpt, kind: z.literal('model_capability'), model: z.string().trim().min(1).max(120) })
            .strict(),
        ]),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (value) =>
      [
        ...value.excerpts
          .map((item) => item.text)
          .join('')
          .replace(/\s/g, ''),
      ].length <= 300,
  );

/** A selected part of the existing approved primer, never a new memory or approval owner. */
export function readProfileOpeningReference(content: string) {
  if (content.length > 20_000) return null;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter?.[1]) return null;
  try {
    const raw: unknown = parse(frontmatter[1], { maxAliasCount: 0 });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const parsed = profileOpeningReferenceSchema.safeParse((raw as Record<string, unknown>).opening);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ProfileOpeningReference = z.infer<typeof profileOpeningReferenceSchema>;

/** Edit only the selected opening reference; all other profile fields and body stay in their original owner. */
export function updateProfileOpeningReference(
  content: string,
  reference: ProfileOpeningReference | null,
): string | null {
  if (content.length > 20_000 || (reference && !profileOpeningReferenceSchema.safeParse(reference).success))
    return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) return null;
  try {
    const doc = parseDocument(match[1]);
    if (doc.errors.length || !isMap(doc.contents)) return null;
    doc.toJS({ maxAliasCount: 0 });
    if (reference) doc.set('opening', reference);
    else doc.delete('opening');
    return `---\n${doc.toString()}---\n${content.slice(match[0].length)}`;
  } catch {
    return null;
  }
}

export function splitProfileBody(content: string): { prefix: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? { prefix: match[0], body: content.slice(match[0].length) } : { prefix: '', body: content };
}
