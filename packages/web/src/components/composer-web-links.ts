import { createMarkdownProcessor } from '@cat-cafe/ui';
import type { Nodes, Root } from 'mdast';
import { chatMarkdownPlugins, prepareChatMarkdown, transformChatMarkdownUrl } from './chat-markdown';

const processor = createMarkdownProcessor(chatMarkdownPlugins(true));

/** Highlight source constructs, using the context the draft will have after sending. */
export function composerWebLinks(source: string) {
  const ranges: { start: number; end: number; href: string }[] = [];
  const targets: string[] = [];
  let unmapped = 0;
  if (!/https?|www|[&\\]/i.test(source)) return { ranges, unmapped, targets };
  const content = source.trim();
  const { md, offset } = prepareChatMarkdown(content);
  const sourceOffset = source.length - source.trimStart().length + offset;
  const tree = processor.runSync(processor.parse(md), { value: md }) as Root;
  const visit = (node: Nodes) => {
    if (node.type === 'link') {
      const url = transformChatMarkdownUrl(node.url);
      if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return;
      const href = new URL(url).href;
      targets.push(href);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null) unmapped++;
      else ranges.push({ start: start + sourceOffset, end: end + sourceOffset, href });
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  return { ranges, unmapped, targets };
}
