import { splitProfileBody } from '@cat-cafe/shared/profile-opening-reference';
import type { Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { formatModelName } from '@/lib/model-display-name';
import type { ProfileMemoryRead } from './owner-memory-read';

const parser = unified().use(remarkParse);
function nodeText(node: Root | RootContent, includeHeadings = true): string {
  if (node.type === 'heading' && !includeHeadings) return '';
  if (node.type === 'break') return '\n';
  if ('value' in node) return node.value;
  if ('alt' in node) return node.alt ?? '';
  if ('children' in node) {
    const separator = ['root', 'blockquote', 'list', 'listItem'].includes(node.type) ? '\n' : '';
    return node.children.map((child) => nodeText(child as RootContent, includeHeadings)).join(separator);
  }
  return '';
}
export function profileText(content: string): string {
  const lines = nodeText(parser.parse(splitProfileBody(content).body) as Root, false)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return lines.reduce((text, line) => {
    const chineseBoundary =
      /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]$/u.test(text) ||
      /^[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(line);
    return text + (text && !chineseBoundary ? ' ' : '') + line;
  }, '');
}
export function profileSections(content: string): { title: string; body: string }[] {
  const body = splitProfileBody(content).body;
  const nodes = (parser.parse(body) as Root).children;
  const headings = nodes.filter((node) => node.type === 'heading');
  const depth = headings.some((node) => node.depth === 2) ? 2 : Math.min(...headings.map((node) => node.depth));
  const boundaries = headings.filter((node) => node.depth === depth);
  if (!boundaries.length) return [{ title: '', body }];
  const sections: { title: string; body: string }[] = [];
  // A document title is redundant with the detail header; its following introduction is not.
  const firstOffset = boundaries[0].position?.start.offset ?? 0;
  const introNodes = nodes.filter(
    (node) => (node.position?.start.offset ?? 0) < firstOffset && node.type !== 'heading',
  );
  if (introNodes.length)
    sections.push({ title: '', body: body.slice(introNodes[0].position?.start.offset ?? 0, firstOffset).trim() });
  boundaries.forEach((node, index) => {
    sections.push({
      title: nodeText(node),
      body: body
        .slice(node.position?.end.offset ?? 0, boundaries[index + 1]?.position?.start.offset ?? body.length)
        .trim(),
    });
  });
  return sections;
}
export function profileIdentity(entry: ProfileMemoryRead, cats: readonly CatData[], hasFetched: boolean) {
  const members =
    entry.layer === 'primer' && hasFetched ? cats.filter((cat) => cat.relationshipKey === entry.relationshipKey) : [];
  const names = members.map((cat) => cat.nickname || cat.displayName).filter(Boolean);
  const relationshipTitle = !hasFetched
    ? '关系画像'
    : names.length
      ? `与 ${[...new Set(names)].join('、')} 的关系画像`
      : '未关联成员的关系画像';
  return {
    members,
    title: entry.layer === 'capsule' ? '关于你' : entry.layer === 'corpus' ? '共同画像' : relationshipTitle,
    memberNotice: entry.layer === 'primer' && !hasFetched ? '成员资料尚未读到' : null,
    memberLabels: [
      ...new Set(
        members.map((cat) =>
          formatCatDisplayName({ ...cat, variantLabel: cat.variantLabel?.trim() || formatModelName(cat.defaultModel) }),
        ),
      ),
    ].join(' · '),
  };
}
