import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';

/** Explicit routing wins. Otherwise read line-start addressees, never quoted code or inline prose. */
export function crossThreadLetterRecipients(
  content: string,
  targetCats?: readonly string[],
  mentionsUser = false,
): string[] {
  const toCat = getMentionToCat();
  if (targetCats?.length) return [...new Set(targetCats.map((id) => toCat[id.replace(/^@/, '').toLowerCase()] ?? id))];

  const recipients = new Set<string>();
  // Reuse the ingress's owner-mention fact (including configured aliases/CJK boundaries).
  if (mentionsUser) recipients.add('__co-creator__');
  const mention = getMentionRe();
  let fence: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const start = line.replace(/^\s*(?:(?:[-*+]|\d+[.)]|>)\s+)*/, '');
    mention.lastIndex = 0;
    const match = mention.exec(start);
    if (match?.index === 0) {
      const id = toCat[match[1].toLowerCase()];
      if (id) recipients.add(id);
    }
  }
  return [...recipients];
}
