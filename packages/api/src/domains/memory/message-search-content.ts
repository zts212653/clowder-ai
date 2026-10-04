/** Canonical searchable text projection shared by index writing and source validation. */
export interface SearchableMessageContent {
  content: string;
  contentBlocks?: readonly unknown[];
  richBlocks?: readonly unknown[];
}

const SEARCHABLE_BLOCK_TEXT_FIELDS = [
  'text',
  'alt',
  'caption',
  'title',
  'subtitle',
  'label',
  'description',
  'body',
  'bodyMarkdown',
  'markdown',
  'summary',
];

export function buildSearchableMessageContent(message: SearchableMessageContent): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };

  push(message.content);
  for (const block of message.contentBlocks ?? []) collectBlockText(block, push);
  for (const block of message.richBlocks ?? []) collectBlockText(block, push);

  return parts.join('\n');
}

function collectBlockText(block: unknown, push: (value: unknown) => void): void {
  if (!block || typeof block !== 'object') return;
  const obj = block as Record<string, unknown>;

  for (const field of SEARCHABLE_BLOCK_TEXT_FIELDS) {
    push(obj[field]);
  }

  const items = obj.items;
  if (Array.isArray(items)) {
    for (const item of items) collectBlockText(item, push);
  }

  const sections = obj.sections;
  if (Array.isArray(sections)) {
    for (const section of sections) collectBlockText(section, push);
  }
}
