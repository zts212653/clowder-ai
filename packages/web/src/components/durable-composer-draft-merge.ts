import type { ContextAttachment } from '@cat-cafe/shared';
import { mergeHydratedDraft } from './durable-composer-draft-helpers';

export function mergeContextAttachments(
  authoritative: readonly ContextAttachment[],
  local: readonly ContextAttachment[],
): ContextAttachment[] {
  return [...new Map([...authoritative, ...local].map((attachment) => [attachment.id, attachment])).values()];
}

export function applyContextAttachmentDelta(
  current: readonly ContextAttachment[],
  incoming: readonly ContextAttachment[],
  removedIds: ReadonlySet<string>,
): ContextAttachment[] {
  if (removedIds.size === 0) return mergeContextAttachments(current, incoming);

  const replacements = new Map(
    incoming.filter((attachment) => removedIds.has(attachment.id)).map((attachment) => [attachment.id, attachment]),
  );
  const consumed = new Set<string>();
  const next = current.flatMap((attachment) => {
    if (!removedIds.has(attachment.id)) return [attachment];
    const replacement = replacements.get(attachment.id);
    if (!replacement) return [];
    consumed.add(attachment.id);
    return [replacement];
  });
  const present = new Set(next.map((attachment) => attachment.id));

  for (const attachment of incoming) {
    if (consumed.has(attachment.id) || present.has(attachment.id)) continue;
    next.push(attachment);
    present.add(attachment.id);
  }
  return next;
}

export function rebaseAuthoritativeText(serverText: string, baseText: string | undefined, localText: string): string {
  if (baseText === undefined || localText === baseText) return serverText;
  if (localText.startsWith(baseText)) return `${serverText}${localText.slice(baseText.length)}`;
  return mergeHydratedDraft(serverText, localText);
}

export function rebaseAuthoritativeImageUrls(
  authoritative: readonly string[],
  base: readonly string[] | undefined,
  local: readonly string[],
): string[] {
  if (!base) return [...authoritative];
  const before = new Set(base);
  const current = new Set(local);
  return [
    ...new Set([
      ...authoritative.filter((url) => !before.has(url) || current.has(url)),
      ...local.filter((url) => !before.has(url)),
    ]),
  ];
}

export function rebaseAuthoritativeContext(
  authoritative: readonly ContextAttachment[],
  base: readonly ContextAttachment[] | undefined,
  local: readonly ContextAttachment[],
): ContextAttachment[] {
  if (!base) return mergeContextAttachments(authoritative, local);
  const before = new Map(base.map((value) => [value.id, value]));
  const current = new Set(local.map((value) => value.id));
  const retained = authoritative.filter((value) => !before.has(value.id) || current.has(value.id));
  const changed = local.filter((value) => JSON.stringify(value) !== JSON.stringify(before.get(value.id)));
  return mergeContextAttachments(retained, changed);
}
