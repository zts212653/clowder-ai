import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface MarkdownLinkNode {
  readonly type: string;
  readonly url?: string;
  readonly children?: readonly MarkdownLinkNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm);
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;

/** Keep the authoring boundary aligned with the non-executable Markdown reader. */
export function isSafeMarkdownUrl(raw: string): boolean {
  const url = raw.trim();
  const hasControlOrBackslash = [...url].some(
    (character) => character === '\\' || character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
  );
  if (!url || hasControlOrBackslash || url.startsWith('//')) return false;
  const scheme = URI_SCHEME.exec(url)?.[0].slice(0, -1).toLowerCase();
  if (scheme !== undefined) return scheme === 'http' || scheme === 'https';
  const rawPath = url.split(/[?#]/u, 1)[0];
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  return !path.split('/').includes('..');
}

/** Returns unique unsafe destinations in source order; prose and raw HTML are not executed by the reader. */
export function unsafeMarkdownUrls(markdown: string): string[] {
  const urls: string[] = [];
  const visit = (node: MarkdownLinkNode) => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.url) {
      if (!isSafeMarkdownUrl(node.url) && !urls.includes(node.url)) urls.push(node.url);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(markdown) as MarkdownLinkNode);
  return urls;
}
