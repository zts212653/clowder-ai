import type { RichBlock, RichCardBlock } from '@cat-cafe/shared';
import { parseUnifiedDiff } from '@cat-cafe/ui';
import type { ChatMessage } from '@/stores/chat-types';

export interface RichView {
  title: string;
  rk: RichBlock['kind'];
  /** Render type `kind[.subtype]`: templates are looked up by its longest registered prefix. */
  type: string;
  mid: string;
  block: RichBlock;
  markdown?: string;
  checked?: number;
  count?: number;
  filePath?: string;
  kv?: { k: string; v: string }[];
  checks?: { label: string; done: boolean }[];
  diff?: { mode: string; hunks: [string, [string, string][]][] };
  cards?: {
    items: {
      src: string;
      alt: string;
      work: string;
      title: string;
    }[];
  };
  audio?: { id: string; kind: string; src: string; label: string };
  file?: { name: string; size?: number; source: string; work: string };
  widget?: { html: string };
  pick?: {
    mid: string;
    b: string;
    group: string;
    interactiveType: string;
    opts: { v: string; label: string; sub: string; on: boolean }[];
    value: string;
    custom: { id: string; ph: string } | null;
    allowRandom: boolean;
    submit: boolean;
    done: boolean;
    cant: boolean;
    result: string[];
  };
}

/** Source block coordinates remain intact; rendering belongs to the copied components. */
export function richBlockView(
  block: RichBlock,
  mid: string,
  file: (url: string) => string,
  draft: Record<string, unknown> = {},
  siblings: RichBlock[] = [block],
): RichView | null {
  const view = kindView(block, mid, file, draft, siblings);
  const subtype = block.kind === 'card' && typeof block.meta?.kind === 'string' ? '.' + block.meta.kind : '';
  return view && { ...view, type: block.kind + subtype, mid, block };
}

function kindView(
  block: RichBlock,
  mid: string,
  file: (url: string) => string,
  draft: Record<string, unknown>,
  siblings: RichBlock[],
): Omit<RichView, 'type' | 'mid' | 'block'> | null {
  switch (block.kind) {
    case 'card':
      return {
        rk: block.kind,
        title: block.title,
        markdown: block.bodyMarkdown,
        kv: block.fields?.map((f) => ({ k: f.label, v: f.value })),
      };
    case 'checklist':
      return {
        rk: block.kind,
        title: block.title ?? '',
        checked: block.items.filter((item) => item.checked).length,
        count: block.items.length,
        checks: block.items.map((item) => ({ label: item.text, done: !!item.checked })),
      };
    case 'diff':
      return {
        rk: block.kind,
        title: '',
        filePath: block.filePath,
        diff: {
          mode: 'unified',
          hunks: parseUnifiedDiff(block.diff, block.filePath).flatMap((f) =>
            f.hunks.map((h): [string, [string, string][]] => [
              h.header,
              h.lines
                .filter((l) => l.type !== 'header')
                .map((l) => [l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ', l.content]),
            ]),
          ),
        },
      };
    case 'media_gallery':
      return {
        rk: block.kind,
        title: block.title ?? '',
        count: block.items.length,
        cards: {
          items: block.items.map((item) => ({
            src: file(item.url),
            title: item.caption || item.alt || '',
            alt: item.alt ?? '',
            work: '',
          })),
        },
      };
    case 'audio':
      return {
        rk: block.kind,
        title: block.title ?? '',
        markdown: block.text,
        audio: {
          id: `${mid}:${block.id}`,
          kind: 'audio',
          src: file(block.url),
          label: block.title ?? block.text ?? '',
        },
      };
    case 'file':
      return {
        rk: block.kind,
        title: '',
        file: { name: block.fileName, size: block.fileSize, source: file(block.url), work: '' },
      };
    case 'html_widget':
      return { rk: block.kind, title: block.title ?? '', widget: { html: block.html } };
    case 'interactive': {
      const key = `${mid}:${block.id}`;
      const selected = (b: typeof block): string[] =>
        b.disabled ? (b.selectedIds ?? []) : ((draft[`pick:${mid}:${b.id}`] as string[] | undefined) ?? []);
      const ids = selected(block);
      const group = block.groupId
        ? siblings.filter((b): b is typeof block => b.kind === 'interactive' && b.groupId === block.groupId)
        : [block];
      const custom = !block.disabled && block.options.find((o) => o.customInput && ids.includes(o.id));
      return {
        rk: block.kind,
        title: block.title ?? '',
        pick: {
          mid,
          b: block.id,
          group: `pick-${key}`,
          interactiveType: block.interactiveType,
          opts: block.options.map((o) => ({
            v: o.id,
            label: o.label,
            sub: o.description ?? '',
            on: ids.includes(o.id),
          })),
          value: ids[0] ?? '',
          custom: custom ? { id: `pick-${key}-t`, ph: custom.customInputPlaceholder ?? '' } : null,
          allowRandom: !!block.allowRandom,
          submit: !block.disabled && group.at(-1)?.id === block.id,
          cant: !group.every(
            (b) =>
              selected(b).length &&
              (!b.options.some((o) => o.customInput && selected(b).includes(o.id)) ||
                String(draft[`pick-${mid}:${b.id}-t`] ?? '').trim()),
          ),
          done: !!block.disabled,
          result: block.disabled ? block.options.filter((o) => ids.includes(o.id)).map((o) => o.label) : [],
        },
      };
    }
  }
}

export function messageRichBlocks(message: ChatMessage): RichBlock[] {
  const images = (message.contentBlocks ?? []).filter((b) => b.type === 'image');
  const content: RichBlock[] = images.length
    ? [{ id: 'content-images', v: 1, kind: 'media_gallery', items: images.map((b) => ({ url: b.url, alt: b.alt })) }]
    : [];
  for (const [i, block] of (message.contentBlocks ?? []).entries())
    if (block.type === 'file') content.push({ id: `content-${i}`, v: 1, kind: 'file', ...block });
  return [...content, ...(message.extra?.rich?.blocks ?? [])];
}

export function isActionCard(block: RichBlock): block is RichCardBlock {
  return block.kind === 'card' && !!(block.actions?.length || block.meta?.approval || block.meta?.kind);
}
