import { createContext } from 'react';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const OPEN = '\uE200genui\uE202';
const CLOSE = '\uE201';
const parser = unified().use(remarkParse).use(remarkGfm);
export const ProviderCitationContext = createContext(false);
interface RangeNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: RangeNode[];
}

function literalRanges(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  const visit = (node: RangeNode) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(content) as RangeNode);
  return ranges;
}

function citationEnvelope(payload: string): { citation: unknown } | undefined {
  if (payload.length > 4096) return undefined;
  try {
    const envelope: unknown = JSON.parse(payload);
    if (typeof envelope !== 'object' || envelope === null || !('citation' in envelope)) return undefined;
    return { citation: envelope.citation };
  } catch {
    return /^\s*\{\s*"citation"\s*:/u.test(payload) ? { citation: null } : undefined;
  }
}

function sourceLink(citation: unknown): string | undefined {
  try {
    if (typeof citation !== 'object' || citation === null || !('url' in citation)) return undefined;
    if (
      typeof citation.url !== 'string' ||
      citation.url.length > 2048 ||
      /[\s<>]/u.test(citation.url) ||
      [...citation.url].some((char) => char.charCodeAt(0) < 32)
    )
      return undefined;
    const url = new URL(citation.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    const title =
      'title' in citation && typeof citation.title === 'string' && citation.title.trim()
        ? citation.title.slice(0, 256)
        : '来源';
    const label = title.replace(/[\\[\]`*_<>]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
    return `[${label}](<${url.href}>)`;
  } catch {
    return undefined;
  }
}

/** Display only: never mutate stored prose or guess URLs from provider-private turn references. */
export function projectProviderCitations(content: string): { markdown: string; unresolved: number } {
  if (!content.includes('\uE200')) return { markdown: content, unresolved: 0 };
  const literals = literalRanges(content);
  for (let length = OPEN.length - 1; length > 0; length -= 1) {
    const start = content.length - length;
    if (content.endsWith(OPEN.slice(0, length)) && !literals.some(([a, b]) => start >= a && start < b)) {
      content = content.slice(0, start);
      break;
    }
  }
  let markdown = '';
  let unresolved = 0;
  let last = 0;
  let cursor = 0;
  for (;;) {
    const start = content.indexOf(OPEN, cursor);
    if (start < 0) break;
    if (literals.some(([a, b]) => start >= a && start < b)) {
      cursor = start + OPEN.length;
      continue;
    }
    const end = content.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) return { markdown: markdown + content.slice(last, start), unresolved };
    if (literals.some(([a, b]) => start < b && end >= a)) {
      cursor = end + CLOSE.length;
      continue;
    }
    const envelope = citationEnvelope(content.slice(start + OPEN.length, end));
    if (!envelope) {
      cursor = end + CLOSE.length;
      continue;
    }
    const link = sourceLink(envelope.citation);
    markdown += content.slice(last, start) + (link ?? '');
    if (!link) unresolved += 1;
    last = cursor = end + CLOSE.length;
  }
  return { markdown: markdown + content.slice(last), unresolved };
}
