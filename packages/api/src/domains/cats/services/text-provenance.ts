import { createHash } from 'node:crypto';
import type { MessageOutputOwner } from '@cat-cafe/shared';
import { z } from 'zod';
import { normalizeJsonUnicode } from '../../../utils/json-unicode.js';

export interface TextSourcePart {
  content: string;
  textSource?: 'provider_summary';
}

const provenanceSchema = z
  .object({
    v: z.literal(1),
    owner: z.object({ threadId: z.string(), catId: z.string(), turnInvocationId: z.string() }).strict(),
    contentRevision: z.object({ length: z.number().int().nonnegative(), sha256: z.string() }).strict(),
    providerSummaryRanges: z
      .array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict())
      .min(1),
  })
  .strict();

/** References the draft's one canonical body; unavailable provenance never grants text authority. */
export type TextProvenance = z.infer<typeof provenanceSchema> | { v: 1; status: 'unavailable' };

const contentRevision = (content: string) => ({
  length: content.length,
  sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
});

export function readTextProvenance(value: unknown): TextProvenance {
  const parsed = provenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : { v: 1, status: 'unavailable' };
}

/** Capture source ranges from the same ordered pieces used to form the streamed body. */
export function captureTextProvenance(
  owner: MessageOutputOwner,
  parts: readonly TextSourcePart[],
): TextProvenance | undefined {
  let content = '';
  const providerSummaryRanges: Array<{ start: number; end: number }> = [];
  for (const part of parts) {
    const start = content.length;
    content += part.content;
    if (part.textSource !== 'provider_summary' || content.length === start) continue;
    const previous = providerSummaryRanges.at(-1);
    if (previous?.end === start) previous.end = content.length;
    else providerSummaryRanges.push({ start, end: content.length });
  }
  if (!providerSummaryRanges.length) return undefined;
  return { v: 1, owner, contentRevision: contentRevision(normalizeJsonUnicode(content)), providerSummaryRanges };
}

/** Legacy drafts have no source map. An invalid, stale or foreign map keeps the entire body passive. */
export function restoreTextSourceParts(
  content: string,
  provenance: TextProvenance | undefined,
  owner: MessageOutputOwner,
): readonly TextSourcePart[] {
  if (provenance === undefined) return [{ content }];
  const passive = [{ content, textSource: 'provider_summary' as const }];
  const parsed = readTextProvenance(provenance);
  if ('status' in parsed) return passive;
  const revision = contentRevision(content);
  if (
    parsed.owner.threadId !== owner.threadId ||
    parsed.owner.catId !== owner.catId ||
    parsed.owner.turnInvocationId !== owner.turnInvocationId ||
    parsed.contentRevision.length !== revision.length ||
    parsed.contentRevision.sha256 !== revision.sha256
  )
    return passive;
  const parts: TextSourcePart[] = [];
  let cursor = 0;
  for (const { start, end } of parsed.providerSummaryRanges) {
    if (start < cursor || end <= start || end > content.length) return passive;
    if (start > cursor) parts.push({ content: content.slice(cursor, start) });
    parts.push({ content: content.slice(start, end), textSource: 'provider_summary' });
    cursor = end;
  }
  if (cursor < content.length) parts.push({ content: content.slice(cursor) });
  return parts;
}
