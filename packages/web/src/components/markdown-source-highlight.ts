import { createMarkdownProcessor } from '@cat-cafe/ui';
import type { Parent, Root, RootContent, Text } from 'mdast';
import type { Plugin } from 'unified';

export interface MarkdownSourceHighlight {
  start: number;
  end: number;
}
const markProperties = { className: ['rounded', 'bg-[var(--accent-100)]', 'px-1', 'text-cafe'] };
const parser = createMarkdownProcessor();

/** Decode only when Markdown escapes/entities make source and display offsets differ. */
function displayedLength(source: string): number {
  const length = (node: Root | RootContent): number => {
    if ('children' in node) return node.children.reduce((sum, child) => sum + length(child), 0);
    return 'value' in node ? node.value.length : 0;
  };
  return length(parser.parse(`x${source}x`)) - 2;
}

/** Mark the bound source range in the AST, including inline code and emphasis, without raw HTML. */
export const remarkSourceHighlight: Plugin<[MarkdownSourceHighlight], Root> =
  ({ start, end }) =>
  (tree, file) => {
    const source = String(file.value);
    const visit = (parent: Parent) => {
      parent.children = parent.children.flatMap<RootContent>((node) => {
        if ('children' in node) visit(node);
        if (node.type !== 'text' && node.type !== 'inlineCode') return [node];
        const from = node.position?.start.offset,
          to = node.position?.end.offset;
        if (from === undefined || to === undefined || from >= end || to <= start) return [node];
        const raw = source.slice(from, to);
        const ticks = node.type === 'inlineCode' ? (raw.match(/^`+/u)?.[0].length ?? 0) : 0;
        const literal = ticks ? raw.slice(ticks, -ticks).replace(/\r?\n/gu, ' ') : raw;
        const inset = ticks + (ticks && literal !== node.value && literal.startsWith(' ') ? 1 : 0);
        const offset = (at: number) => {
          const relative = Math.max(0, Math.min(at - from - inset, literal.length));
          return node.type === 'inlineCode' || literal === node.value
            ? relative
            : displayedLength(literal.slice(0, relative));
        };
        const left = Math.min(node.value.length, offset(start)),
          right = Math.min(node.value.length, offset(end));
        if (right <= left) return [node];
        const before = node.value.slice(0, left),
          hit = node.value.slice(left, right),
          after = node.value.slice(right);
        if (node.type === 'inlineCode') {
          node.data = {
            ...node.data,
            hChildren: [
              { type: 'text', value: before },
              {
                type: 'element',
                tagName: 'mark',
                properties: markProperties,
                children: [{ type: 'text', value: hit }],
              },
              { type: 'text', value: after },
            ],
          };
          return [node];
        }
        const marked: Text = { type: 'text', value: hit, data: { hName: 'mark', hProperties: markProperties } };
        return [{ type: 'text', value: before } as Text, marked, { type: 'text', value: after } as Text];
      });
    };
    visit(tree);
  };
