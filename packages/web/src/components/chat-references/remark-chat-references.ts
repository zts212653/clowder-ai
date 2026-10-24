import { isChatCommitCandidate, isChatPathCandidate, parseLegacyChatPathReference } from '@cat-cafe/shared';
import type { Link, PhrasingContent, Root, RootContent } from 'mdast';
import { attachReferenceAffixes } from './chat-reference-affixes';

const token =
  /(^|[\s（(「『【《，。；：、“‘])((?:https?:\/\/[^\s<>[\]）)」』】》，。；、“‘]+)|(?:[~.]?\/[^\s<>[\]）)」』】》，。；、“‘]+)|(?:[\p{L}\p{N}_@.-]+\/[^\s<>[\]）)」』】》，。；、“‘]*)|(?:[\p{L}\p{N}_@.-]+\.[a-zA-Z0-9]{1,12}(?::[1-9]\d*(?::[1-9]\d*)?)?)|(?:[a-fA-F0-9]{7,40}))(?=\[wt:|$|[\s）)」』】》，。；、“‘.,;:!?！？：])/gu;
const candidate = (value: string) =>
  /^https?:\/\//.test(value) || isChatPathCandidate(value) || isChatCommitCandidate(value);

function localLinkReference(value: string): string {
  if (/^https?:\/\//.test(value)) return value;
  const [path, fragment] = value.split('#');
  try {
    return decodeURIComponent(path) + (/^L[1-9]\d*$/.test(fragment ?? '') ? `:${fragment.slice(1)}` : '');
  } catch {
    return path;
  }
}
function link(value: string, format: 'text' | 'code' | 'link', children?: PhrasingContent[]): Link {
  return {
    type: 'link',
    url: value,
    children: children ?? [{ type: 'text', value }],
    data: { hProperties: { 'data-chat-reference': value, 'data-chat-format': format } },
  };
}
function splitText(value: string): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  let end = 0;
  for (const match of value.matchAll(token)) {
    const reference = match[2].replace(/[.,;:!?，。；：、！？]+$/u, '');
    if (!candidate(reference)) continue;
    const start = match.index + match[1].length;
    if (start > end) result.push({ type: 'text', value: value.slice(end, start) });
    result.push(link(reference, 'text'));
    end = start + reference.length;
  }
  if (end < value.length) result.push({ type: 'text', value: value.slice(end) });
  return result.length ? result : [{ type: 'text', value }];
}

type Node = Root | RootContent | PhrasingContent;
function markReference(node: Link) {
  if (!candidate(node.url)) return;
  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      'data-chat-reference': localLinkReference(node.url),
      'data-chat-format': 'link',
    },
  };
}
function markStandaloneGroup(node: Node, children: Array<RootContent | PhrasingContent>) {
  if (node.type !== 'paragraph' && node.type !== 'listItem') return;
  const meaningful = children.filter(
    (child) => child.type !== 'break' && !(child.type === 'text' && !child.value.trim()),
  );
  if (
    !meaningful.length ||
    !meaningful.every((child) => child.type === 'link' && child.data?.hProperties?.['data-chat-reference'])
  )
    return;
  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      'data-chat-reference-group': meaningful.length > 1 ? 'grid' : 'single',
      'data-chat-reference-candidates': meaningful.map((child) =>
        String(child.data?.hProperties?.['data-chat-reference']),
      ),
    },
  };
  for (const child of meaningful)
    child.data = { ...child.data, hProperties: { ...child.data?.hProperties, 'data-chat-layout': 'card' } };
}
function visit(node: Node, definitions: Map<string, string>): void {
  if (node.type === 'code' || node.type === 'image' || node.type === 'linkReference') return;
  if (node.type === 'link') {
    markReference(node);
    return;
  }
  if (!('children' in node)) return;
  const children = node.children as Array<RootContent | PhrasingContent>;
  const transformed = children.flatMap((child): Array<RootContent | PhrasingContent> => {
    if (child.type === 'inlineCode' && candidate(child.value))
      return [
        link(child.value, 'code', [{ type: 'text', value: parseLegacyChatPathReference(child.value).reference }]),
      ];
    if (child.type === 'linkReference') {
      const href = definitions.get(child.identifier);
      if (!href || !candidate(href)) return [child];
      const resolved = link(href, 'link', child.children);
      markReference(resolved);
      return [resolved];
    }
    if (child.type === 'text') return splitText(child.value);
    visit(child, definitions);
    return [child];
  });
  // Historical messages can select a registered worktree; no current producer emits these tags.
  for (let index = 0; index + 1 < transformed.length; index++) {
    const path = transformed[index],
      suffix = transformed[index + 1];
    if (path.type !== 'link' || suffix.type !== 'text' || /^https?:/.test(path.url)) continue;
    const hint = /^\s*\[wt:([a-zA-Z0-9_/-]+)\]/.exec(suffix.value);
    if (!hint || !path.data?.hProperties?.['data-chat-reference']) continue;
    path.data.hProperties['data-chat-reference'] += ` [wt:${hint[1]}]`;
    suffix.value = suffix.value.slice(hint[0].length);
  }
  children.splice(0, children.length, ...attachReferenceAffixes(transformed));
  markStandaloneGroup(node, children);
}
/** Parse only Markdown prose. Fenced/indented code, images and existing-link children remain literal. */
export function remarkChatReferences() {
  return (tree: Root) => {
    const definitions = new Map<string, string>();
    function collect(node: Node) {
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
      if ('children' in node) for (const child of node.children) collect(child);
    }
    collect(tree);
    visit(tree, definitions);
  };
}
