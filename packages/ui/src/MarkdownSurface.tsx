import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

type Props = ComponentProps<typeof ReactMarkdown> & { sourceCoordinates?: boolean };

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: readonly MarkdownNode[];
}
const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);

/** Use the same Markdown language, so code/plain links cannot accidentally hide an attached image. */
export function markdownImageReferences(source: string): ReadonlySet<string> {
  const tree = markdownParser.parse(source);
  const definitions = new Map<string, string>();
  const images: string[] = [];
  const references: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === 'image' && node.url) images.push(node.url);
    else if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier, node.url);
    else if (node.type === 'imageReference' && node.identifier) references.push(node.identifier);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  for (const reference of references) {
    const url = definitions.get(reference);
    if (url) images.push(url);
  }
  return new Set(images);
}

const position = (node?: { position?: { start: { offset?: number }; end: { offset?: number } } }) => ({
  'data-source-start': node?.position?.start.offset,
  'data-source-end': node?.position?.end.offset,
});
// Stable component types preserve nested media/interaction state during language, read and draft updates.
const sourceComponents: Components = {
  p: ({ node, ...props }) => <p {...props} {...position(node)} />,
  h1: ({ node, ...props }) => <h1 {...props} {...position(node)} />,
  h2: ({ node, ...props }) => <h2 {...props} {...position(node)} />,
  h3: ({ node, ...props }) => <h3 {...props} {...position(node)} />,
  li: ({ node, ...props }) => <li {...props} {...position(node)} />,
  td: ({ node, ...props }) => <td {...props} {...position(node)} />,
  pre: ({ node, ...props }) => <pre {...props} {...position(node)} />,
};

/** Shared Markdown language; each location supplies its own links, media and private actions. */
export function MarkdownSurface({ sourceCoordinates, components, remarkPlugins = [], ...props }: Props) {
  return (
    <ReactMarkdown
      {...props}
      remarkPlugins={[remarkGfm, remarkBreaks, ...(remarkPlugins ?? [])]}
      components={{ ...(sourceCoordinates ? sourceComponents : {}), ...components }}
    />
  );
}
