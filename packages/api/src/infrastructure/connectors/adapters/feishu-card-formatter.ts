import type { RichBlock } from '@cat-cafe/shared';

const TONE_TO_COLOR: Record<string, string> = {
  info: 'blue',
  success: 'green',
  warning: 'orange',
  danger: 'red',
};

interface LarkCardElement {
  tag: string;
  [key: string]: unknown;
}

export interface LarkCard {
  header: { title: { content: string; tag: string }; template: string };
  elements: LarkCardElement[];
}

function blockToElements(block: RichBlock): LarkCardElement[] {
  switch (block.kind) {
    case 'card': {
      const els: LarkCardElement[] = [];
      if (block.bodyMarkdown) {
        els.push({ tag: 'markdown', content: block.bodyMarkdown });
      }
      if (block.fields?.length) {
        els.push({
          tag: 'markdown',
          content: block.fields.map((f) => `**${f.label}**: ${f.value}`).join('\n'),
        });
      }
      return els;
    }
    case 'checklist': {
      const text = block.items.map((i) => `${i.checked ? '✅' : '☐'} ${i.text}`).join('\n');
      return [{ tag: 'markdown', content: block.title ? `**${block.title}**\n${text}` : text }];
    }
    case 'diff':
      return [
        { tag: 'markdown', content: `**${block.filePath}**` },
        { tag: 'markdown', content: `\`\`\`${block.languageHint || ''}\n${block.diff}\n\`\`\`` },
      ];
    case 'audio':
      return [{ tag: 'markdown', content: block.text ? `🔊 ${block.text}` : '🔊 [Audio]' }];
    case 'media_gallery': {
      const text = block.items.map((i) => `[${i.caption || i.alt || 'image'}](${i.url})`).join('\n');
      return [{ tag: 'markdown', content: block.title ? `**${block.title}**\n${text}` : text }];
    }
    default:
      return [{ tag: 'markdown', content: `[${(block as RichBlock).kind}]` }];
  }
}

export function formatFeishuCard(blocks: RichBlock[], catDisplayName: string, textContent?: string): LarkCard {
  const firstCard = blocks.find((b) => b.kind === 'card');
  const title =
    firstCard && firstCard.kind === 'card' ? `【${catDisplayName}🐱】${firstCard.title}` : `【${catDisplayName}🐱】`;
  const tone = (firstCard?.kind === 'card' && firstCard.tone) || 'info';
  const template = TONE_TO_COLOR[tone] || 'blue';

  const elements: LarkCardElement[] = [];
  if (textContent) {
    elements.push({ tag: 'markdown', content: textContent });
  }
  for (const block of blocks) {
    elements.push(...blockToElements(block));
  }

  return { header: { title: { content: title, tag: 'plain_text' }, template }, elements };
}
