import { createMarkdownProcessor } from '@cat-cafe/ui';
import { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import type { PluggableList } from 'unified';
import { remarkChatReferences } from './chat-references/remark-chat-references';

export const chatMarkdownPlugins = (references: boolean): PluggableList => [
  ...(references ? [remarkChatReferences] : []),
  [remarkMath, { singleDollarTextMath: false }],
];

export function prepareChatMarkdown(content: string, disableCommandPrefix = false) {
  const cmdMatch = disableCommandPrefix ? null : /^(\/\w+)/.exec(content);
  const offset = cmdMatch?.[1].length ?? 0;
  return { cmdMatch, offset, md: normalizeMathDelimiters(content.slice(offset)) };
}

const BARE_MARKDOWN_LINE_HREF_RE = /^[^/:\\?#]+\.mdx?:\d+$/i;
const WINDOWS_ABSOLUTE_PATH_HREF_RE = /^[a-z]:[\\/].*$/i;
const WINDOWS_UNC_PATH_HREF_RE = /^\\\\[^\\]+\\[^\\]+/;

/** Preserve safe file-like forms that react-markdown mistakes for custom URI schemes. */
export function transformChatMarkdownUrl(url: string): string {
  const transformed = defaultUrlTransform(url);
  if (transformed) return transformed;
  if (
    BARE_MARKDOWN_LINE_HREF_RE.test(url) ||
    WINDOWS_ABSOLUTE_PATH_HREF_RE.test(url) ||
    WINDOWS_UNC_PATH_HREF_RE.test(url)
  ) {
    return url;
  }
  return transformed;
}

/* ── LaTeX delimiter normalization ─────────────────────────── */

/**
 * Parse with the real Markdown parser so code fences (``` and ~~~), indented
 * code blocks, and code spans (any backtick run length) are located by their
 * AST positions instead of a hand-rolled regex. Delimiter rewriting must never
 * touch these ranges.
 */
const mdRangeParser = createMarkdownProcessor();

type OffsetRange = [start: number, end: number];

function collectLiteralRanges(md: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const walk = (node: {
    type: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: unknown[];
  }) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start != null && end != null) ranges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(mdRangeParser.parse(md) as Parameters<typeof walk>[0]);
  return ranges;
}

/** Matches \[...\] (group 1) or \(...\) (group 2). */
const BACKSLASH_MATH_RE = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;

/**
 * remark-math only parses $/$$ delimiters; LLMs frequently emit \[...\] and
 * \(...\) instead. Rewrite those to $$...$$ (inline $$ renders as inline math
 * when singleDollarTextMath is off) outside code ranges so KaTeX can render
 * them.
 */
export function normalizeMathDelimiters(md: string): string {
  BACKSLASH_MATH_RE.lastIndex = 0;
  if (!BACKSLASH_MATH_RE.test(md)) return md;
  BACKSLASH_MATH_RE.lastIndex = 0;

  const ranges = collectLiteralRanges(md);
  let out = '';
  let last = 0;
  for (const m of md.matchAll(BACKSLASH_MATH_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (ranges.some(([s, e]) => start < e && end > s)) continue;
    out += md.slice(last, start);
    out += `$${'$'}${m[1] ?? m[2]}$${'$'}`;
    last = end;
  }
  return out + md.slice(last);
}
