'use client';

import { Children, isValidElement, memo, type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import 'katex/dist/katex.min.css';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import { createListenSentenceRemarkPlugin, type ListenSentence } from '@/lib/listen-mode/markdown-sentences';
import { getMentionColor, getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { useChatStore } from '@/stores/chatStore';
import { ChatWorkspaceLink } from './ChatWorkspaceLink';
import { ListenSentenceSpan } from './listen-mode/ListenSentenceSpan';
import { MermaidDiagram } from './MermaidDiagram';
import { createWorkspaceImageComponent, createWorkspaceLinkComponent } from './workspace-md-components';

const BARE_MARKDOWN_LINE_HREF_RE = /^[^/:\\?#]+\.mdx?:\d+$/i;
const WINDOWS_MARKDOWN_HREF_RE = /^[a-z]:[\\/].*\.mdx?(?::\d+)?$/i;

/** Preserve safe file-like forms that react-markdown mistakes for custom URI schemes. */
export function transformChatMarkdownUrl(url: string): string {
  const transformed = defaultUrlTransform(url);
  if (transformed) return transformed;
  if (BARE_MARKDOWN_LINE_HREF_RE.test(url) || WINDOWS_MARKDOWN_HREF_RE.test(url)) return url;
  return transformed;
}

/* ── LaTeX delimiter normalization ─────────────────────────── */

/**
 * Parse with the real Markdown parser so code fences (``` and ~~~), indented
 * code blocks, and code spans (any backtick run length) are located by their
 * AST positions instead of a hand-rolled regex. Delimiter rewriting must never
 * touch these ranges.
 */
const mdRangeParser = unified().use(remarkParse).use(remarkGfm);

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

/* ── @mention highlighting ─────────────────────────────────── */

function highlightMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  const re = getMentionRe();
  const toCat = getMentionToCat();
  const colorMap = getMentionColor();

  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const catId = toCat[m[1].toLowerCase()] ?? 'opus';
    const catColor = colorMap[catId] ?? UNKNOWN_CAT_COLOR.primary;
    const r = Number.parseInt(catColor.slice(1, 3), 16);
    const g = Number.parseInt(catColor.slice(3, 5), 16);
    const b = Number.parseInt(catColor.slice(5, 7), 16);
    parts.push(
      <span
        key={`m${m.index}`}
        className="font-semibold"
        style={{
          color: catColor,
          backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
          borderRadius: 4,
          padding: '1px 5px',
        }}
      >
        {m[0]}
      </span>,
    );
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

/** Process immediate string children → highlight @mentions */
function withMentions(children: ReactNode): ReactNode {
  return Children.map(children, (child) => (typeof child === 'string' ? highlightMentions(child) : child));
}

/* ── Code block with copy button ───────────────────────────── */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    void navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div className="relative group my-2">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded text-micro bg-cafe-surface-sunken text-cafe-muted md:opacity-0 md:group-hover:opacity-100 hover:bg-[var(--console-hover-bg)] transition-opacity"
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre
        ref={preRef}
        className="bg-cafe-surface-sunken text-cafe rounded-lg p-3 overflow-x-auto text-xs leading-5 font-mono [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit [&>code]:text-xs"
      >
        {children}
      </pre>
    </div>
  );
}

/* ── File path → VSCode link ──────────────────────────────── */
const PROJECT_ROOT = process.env.NEXT_PUBLIC_PROJECT_ROOT ?? '';
const FILE_PATH_RE = /(?:^|\s)`?((?:\/[\w.@-]+)+(?:\.[\w]+)(?::(\d+))?)(?:`?)/g;
const REL_PATH_RE = /(?:^|\s)`?((?:packages|src|docs|tests?)\/[\w./@-]+(?:\.[\w]+)(?::(\d+))?)(?:`?)/g;
const WT_TAG_RE = /^\s*\[wt:([a-zA-Z0-9_/-]+)\]/;

function linkifyFilePaths(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  const combined = new RegExp(`${FILE_PATH_RE.source}|${REL_PATH_RE.source}`, 'g');
  let m: RegExpExecArray | null;

  combined.lastIndex = 0;
  while ((m = combined.exec(text)) !== null) {
    const fullMatch = m[0];
    const leading = fullMatch.match(/^\s/)?.[0] ?? '';
    const path = m[1] ?? m[3];
    const line = m[2] ?? m[4];
    if (!path) continue;

    const start = m.index + leading.length;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));

    // Check for [wt:ID] tag immediately after the match
    const afterMatch = text.slice(m.index + fullMatch.length);
    const wtMatch = afterMatch.match(WT_TAG_RE);
    const worktreeId = wtMatch?.[1] ?? undefined;

    // Strip backticks from display
    const display = path;
    const isAbsolute = path.startsWith('/');
    const filePath = path.split(':')[0];
    const absPath = isAbsolute ? filePath : PROJECT_ROOT ? `${PROJECT_ROOT}/${filePath}` : null;
    const href = absPath ? `vscode://file${absPath}${line ? `:${line}` : ''}` : null;

    parts.push(
      href ? (
        <FilePathLink
          key={`fp${m.index}`}
          display={display}
          href={href}
          filePath={filePath!}
          line={line ? parseInt(line, 10) : undefined}
          worktreeId={worktreeId}
        />
      ) : (
        <span key={`fp${m.index}`} className="text-[var(--semantic-info)] font-mono text-[0.85em]">
          {display}
        </span>
      ),
    );
    // Skip past the [wt:ID] tag so it's not rendered as visible text
    if (wtMatch) {
      lastIdx = m.index + fullMatch.length + wtMatch[0].length;
      combined.lastIndex = lastIdx;
    } else {
      lastIdx = m.index + fullMatch.length;
    }
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : [text];
}

/** F063: File path link — click opens in workspace panel, Cmd/Ctrl+click opens in VSCode */
function FilePathLink({
  display,
  href,
  filePath,
  line,
  worktreeId,
}: {
  display: string;
  href: string;
  filePath: string;
  line?: number;
  worktreeId?: string;
}) {
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Cmd/Ctrl+click → VSCode (default link behavior)
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      // Regular click → open in workspace panel (with optional worktree switch)
      setOpenFile(filePath, line ?? null, worktreeId ?? null);
    },
    [setOpenFile, filePath, line, worktreeId],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-[var(--semantic-info)] hover:text-[var(--semantic-info)] hover:underline font-mono text-[0.85em] cursor-pointer"
      title={`点击在工作区中查看 · Cmd+Click 打开 VSCode\n${display}`}
    >
      {display}
    </a>
  );
}

/** Process string children → @mentions + file path links */
function withMentionsAndLinks(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    // First pass: file paths → ReactNode[]
    const linked = linkifyFilePaths(child);
    // Second pass: highlight @mentions in remaining text nodes
    return (
      <>{linked.map((node, i) => (typeof node === 'string' ? <span key={i}>{highlightMentions(node)}</span> : node))}</>
    );
  });
}

function hasMermaidLanguage(className = ''): boolean {
  return /\blanguage-mermaid\b/i.test(className);
}

function codeChildToString(child: ReactNode): string {
  if (typeof child === 'string') return child;
  if (typeof child === 'number') return String(child);
  return '';
}

function codeChildrenToString(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => codeChildToString(child))
    .join('')
    .replace(/\n$/, '');
}

function isMermaidPre(children: ReactNode): boolean {
  const firstChild = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string }>(firstChild)) return false;
  if (firstChild.type === MermaidDiagram) return true;
  return hasMermaidLanguage(firstChild.props.className);
}

function inlineCodeClassName(className = ''): string {
  return `${className} bg-[var(--code-bg)] text-[var(--code-text)] rounded px-1 py-0.5 text-[0.85em] font-mono`;
}

/* ── Markdown component overrides ──────────────────────────── */

/**
 * Build react-markdown component overrides. When `tp` (textProcessor) is provided,
 * it runs BEFORE mention/link processing on every text-containing component
 * (p, strong, em, del, h1-h6, li, a, th, td). Code/pre components are excluded —
 * textProcessor never touches code block content.
 *
 * Using a factory avoids duplicating component definitions: styling is defined once,
 * and textProcessor composition is injected into the mention-processing pipeline.
 */
interface ListenSentenceRendering {
  activeAnchor?: string;
  onStart: (index: number) => void;
}

function buildMdComponents(tp?: (children: ReactNode) => ReactNode, listen?: ListenSentenceRendering): Components {
  // Compose text processing: tp runs first (e.g. replace markers with buttons),
  // then withMentions/withMentionsAndLinks processes remaining strings.
  const m = tp ? (c: ReactNode) => withMentions(tp(c)) : withMentions;
  const ml = tp ? (c: ReactNode) => withMentionsAndLinks(tp(c)) : withMentionsAndLinks;

  const components: Components = {
    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{ml(children)}</p>,
    strong: ({ children }) => <strong className="font-semibold">{m(children)}</strong>,
    em: ({ children }) => <em>{m(children)}</em>,
    del: ({ children }) => <del className="opacity-60">{m(children)}</del>,

    h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{m(children)}</h1>,
    h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{m(children)}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{m(children)}</h3>,
    h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{m(children)}</h4>,
    h5: ({ children }) => (
      <h5 className="text-xs font-semibold mb-1 mt-1.5 first:mt-0 uppercase tracking-wide">{m(children)}</h5>
    ),
    h6: ({ children }) => <h6 className="text-xs font-medium mb-1 mt-1.5 first:mt-0 text-cafe-muted">{m(children)}</h6>,

    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children, className }) => (
      <li className={className === 'task-list-item' ? 'list-none -ml-5 flex items-start gap-1.5' : undefined}>
        {m(children)}
      </li>
    ),
    input: ({ type, checked }) =>
      type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mt-1 h-3.5 w-3.5 rounded border-[var(--console-border-soft)] text-conn-blue-text pointer-events-none"
        />
      ) : (
        <input type={type} />
      ),

    blockquote: ({ children }) => (
      <blockquote className="border-l-[3px] border-cafe pl-3 my-2 italic opacity-80">{children}</blockquote>
    ),
    a: ({ href, children }) => <ChatWorkspaceLink href={href}>{m(children)}</ChatWorkspaceLink>,
    hr: () => <hr className="my-3 border-cafe" />,

    /* Code blocks with copy button — textProcessor intentionally excluded */
    pre: ({ children }) => (isMermaidPre(children) ? children : <CodeBlock>{children}</CodeBlock>),
    code: ({ className = '', children }) =>
      hasMermaidLanguage(className) ? (
        <MermaidDiagram source={codeChildrenToString(children)} />
      ) : (
        <code className={inlineCodeClassName(className)}>{children}</code>
      ),

    /* Tables (GFM) */
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="min-w-full text-sm border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-cafe-surface-elevated">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-cafe px-2 py-1 text-left font-semibold text-xs">{m(children)}</th>
    ),
    td: ({ children }) => <td className="border border-cafe px-2 py-1">{m(children)}</td>,
  };
  if (listen) {
    components.span = ({ children, node: _node, ...props }) => {
      void _node;
      const listenProps = props as Record<string, unknown>;
      const anchor = listenProps['data-listen-sentence-anchor'];
      const rawIndex = listenProps['data-listen-sentence-index'];
      if (typeof anchor === 'string' && (typeof rawIndex === 'number' || typeof rawIndex === 'string')) {
        const index = Number(rawIndex);
        return (
          <ListenSentenceSpan
            anchor={anchor}
            index={index}
            active={listen.activeAnchor === anchor}
            onStart={listen.onStart}
          >
            {children}
          </ListenSentenceSpan>
        );
      }
      return <span {...props}>{children}</span>;
    };
  }
  return components;
}

/** Default components — no textProcessor, built once at module load */
const mdComponents = buildMdComponents();

/* ── Exported component ────────────────────────────────────── */
interface Props {
  content: string;
  className?: string;
  /** Skip slash-command prefix detection (e.g. for rich block bodyMarkdown) */
  disableCommandPrefix?: boolean;
  /** Base directory path for resolving relative links (e.g. "docs/features") */
  basePath?: string;
  /** Worktree ID for resolving workspace-relative image paths */
  worktreeId?: string;
  /** Pre-process text children in all text-containing components (p, strong, em,
   *  del, h1-h6, li, a, th, td) BEFORE mention/link processing. Code/pre components
   *  are excluded — textProcessor never touches code block content.
   *  Useful for replacing text patterns (e.g. markers) with interactive elements. */
  textProcessor?: (children: ReactNode) => ReactNode;
  /** F279 sentence projection for rendered Workspace Markdown. */
  listenSentences?: ListenSentence[];
  activeListenAnchor?: string;
  onListenSentenceStart?: (index: number) => void;
}

/** Check if href is a relative markdown link (not absolute, not external) */
export function isRelativeMdLink(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) return false;
  return /\.mdx?(?:#|$)/.test(href);
}

/** Resolve a relative path against a base directory */
export function resolveRelativePath(base: string, relative: string): string {
  // Strip fragment/hash
  const rawPathname = relative.split('#')[0];
  let clean = rawPathname;
  try {
    clean = decodeURIComponent(rawPathname);
  } catch {
    // Preserve malformed percent bytes literally. Workspace state carries a
    // native path after this one Markdown-URL decoding boundary.
  }
  // base is the directory of the current file (e.g. "docs/features")
  const parts = base ? base.split('/') : [];
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
  disableCommandPrefix,
  basePath,
  worktreeId,
  textProcessor,
  listenSentences,
  activeListenAnchor,
  onListenSentenceStart,
}: Props) {
  const cmdMatch = disableCommandPrefix ? null : /^(\/\w+)/.exec(content);
  const md = normalizeMathDelimiters(cmdMatch ? content.slice(cmdMatch[1].length) : content);

  const listen = useMemo(
    () =>
      listenSentences?.length && onListenSentenceStart
        ? { activeAnchor: activeListenAnchor, onStart: onListenSentenceStart }
        : undefined,
    [activeListenAnchor, listenSentences, onListenSentenceStart],
  );
  const components = useMemo(() => {
    let nextComponents: Components = textProcessor || listen ? buildMdComponents(textProcessor, listen) : mdComponents;

    if (basePath != null) {
      // When textProcessor is active, the workspace link component must also compose it
      const mentionsFn = textProcessor ? (c: ReactNode) => withMentions(textProcessor(c)) : withMentions;
      nextComponents = { ...nextComponents, a: createWorkspaceLinkComponent(basePath, mentionsFn, worktreeId) };
      if (worktreeId) {
        nextComponents = { ...nextComponents, img: createWorkspaceImageComponent(basePath, worktreeId) };
      }
    }

    return nextComponents;
  }, [basePath, listen, textProcessor, worktreeId]);

  return (
    <div className={`markdown-content text-sm break-words ${className ?? ''}`}>
      {cmdMatch && <span className="font-semibold text-[var(--semantic-info)]">{cmdMatch[1]}</span>}
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkBreaks,
          [remarkMath, { singleDollarTextMath: false }],
          ...(listenSentences?.length ? [createListenSentenceRemarkPlugin(listenSentences)] : []),
        ]}
        rehypePlugins={[rehypeKatex]}
        components={components}
        urlTransform={transformChatMarkdownUrl}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
});
