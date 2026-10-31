/** A deliberate Task discussion names its original owner visibly; ordinary send routing remains authoritative. */
export function artifactDiscussionMessage(ownerMention: string, existingText: string, body?: string): string {
  const mention = ownerMention.trim();
  // Only our final standalone target is safe to reuse. A name elsewhere may be an inert quote,
  // code example or URL; ordinary routing, rather than a second Markdown parser, resolves those.
  const alreadyNamed = !body && existingText.trimEnd().split('\n').at(-1)?.trim() === mention;
  return [body ?? '', alreadyNamed ? '' : mention].filter(Boolean).join('\n');
}
