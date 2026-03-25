import type { RichBlock } from '@cat-cafe/shared';

const TELEGRAM_MAX = 4096;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function blockToHtml(block: RichBlock): string {
  switch (block.kind) {
    case 'card': {
      const parts = [`📋 <b>${esc(block.title)}</b>`];
      if (block.bodyMarkdown) parts.push(esc(block.bodyMarkdown));
      if (block.fields?.length) {
        parts.push(block.fields.map((f) => `<b>${esc(f.label)}</b>: ${esc(f.value)}`).join('\n'));
      }
      return parts.join('\n');
    }
    case 'checklist': {
      const header = block.title ? `☑️ <b>${esc(block.title)}</b>` : '☑️ <b>Checklist</b>';
      const items = block.items.map((i) => `${i.checked ? '✅' : '☐'} ${esc(i.text)}`).join('\n');
      return `${header}\n${items}`;
    }
    case 'diff':
      return `📝 <b>${esc(block.filePath)}</b>\n<pre>${esc(block.diff)}</pre>`;
    case 'audio':
      return block.text ? `🔊 ${esc(block.text)}` : '🔊 [Audio]';
    case 'media_gallery': {
      const header = block.title ? `🖼️ <b>${esc(block.title)}</b>` : '🖼️ <b>Gallery</b>';
      const items = block.items.map((i) => esc(i.caption || i.alt || i.url)).join('\n');
      return `${header}\n${items}`;
    }
    default:
      return `[${esc((block as RichBlock).kind)}]`;
  }
}

export function formatTelegramHtml(blocks: RichBlock[], catDisplayName: string, textContent?: string): string {
  const header = `<b>[${esc(catDisplayName)}🐱]</b>`;
  const parts = [header];
  if (textContent) {
    parts.push(esc(textContent));
  }
  parts.push(blocks.map(blockToHtml).join('\n\n'));
  const full = parts.join('\n\n');
  if (full.length <= TELEGRAM_MAX) return full;
  return `${full.slice(0, TELEGRAM_MAX - 1)}…`;
}
