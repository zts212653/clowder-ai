'use client';

import { MarkdownSurface } from '@cat-cafe/ui';
import {
  Children,
  type CSSProperties,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type Components, defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import 'katex/dist/katex.min.css';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import { createListenSentenceRemarkPlugin, type ListenSentence } from '@/lib/listen-mode/markdown-sentences';
import { getDisplayMentionRe, getDisplayMentionToCat, getMentionColor, getMentionLabel } from '@/lib/mention-highlight';
import { useChatStore } from '@/stores/chatStore';
import { ChatWorkspaceLink } from './ChatWorkspaceLink';
import { ChatReference } from './chat-references/ChatReference';
import { ChatReferenceGroup } from './chat-references/ChatReferenceGroup';
import { useChatReferenceThread } from './chat-references/ChatReferenceScope';
import { remarkChatReferences } from './chat-references/remark-chat-references';
import { ChatReferenceDemand, useChatReferenceDemand } from './chat-references/useChatReferenceDemand';
import { ListenSentenceSpan } from './listen-mode/ListenSentenceSpan';
import { MermaidDiagram } from './MermaidDiagram';
import { createWorkspaceImageComponent, createWorkspaceLinkComponent } from './workspace-md-components';

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

const InsideMarkdownLinkContext = createContext(false);

function Mention({ catId, text, style }: { catId: string; text: string; style: CSSProperties }) {
  const insideLink = useContext(InsideMarkdownLinkContext);
  if (insideLink) {
    return (
      <span className="font-semibold" style={style}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cursor-pointer font-semibold"
      onClick={() => useChatStore.getState().openTeamSubject({ type: 'cat', id: catId })}
      aria-label={`在猫猫团队中查看 ${text.replace(/^@/, '')}`}
      style={style}
    >
      {text}
    </button>
  );
}

function highlightMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  const re = getDisplayMentionRe();
  const toCat = getDisplayMentionToCat();
  const colorMap = getMentionColor();
  const labelMap = getMentionLabel();

  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const alias = m[1].toLowerCase();
    const catId = toCat[alias] ?? 'opus';
    const catColor = colorMap[catId] ?? UNKNOWN_CAT_COLOR.primary;
    const r = Number.parseInt(catColor.slice(1, 3), 16);
    const g = Number.parseInt(catColor.slice(3, 5), 16);
    const b = Number.parseInt(catColor.slice(5, 7), 16);
    const style = {
      color: catColor,
      backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
      borderRadius: 4,
      padding: '1px 5px',
    };
    const displayText = labelMap[catId] ? `@${labelMap[catId]}` : m[0];
    parts.push(<Mention key={`m${m.index}`} catId={catId} text={displayText} style={style} />);
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

function buildMdComponents(
  tp?: (children: ReactNode) => ReactNode,
  listen?: ListenSentenceRendering,
  referenceThreadId?: string,
): Components {
  // Compose text processing: tp runs first (e.g. replace markers with buttons),
  // then withMentions/withMentionsAndLinks processes remaining strings.
  const m = tp ? (c: ReactNode) => withMentions(tp(c)) : withMentions;
  const ml = m;

  const components: Components = {
    p: ({ children, node }) => (
      <ChatReferenceGroup
        sourceLine={node?.position?.start.line}
        threadId={referenceThreadId}
        grid={node?.properties?.['data-chat-reference-group'] === 'grid'}
        candidates={
          Array.isArray(node?.properties?.['data-chat-reference-candidates'])
            ? node.properties['data-chat-reference-candidates'].filter(
                (value): value is string => typeof value === 'string',
              )
            : undefined
        }
      >
        {ml(children)}
      </ChatReferenceGroup>
    ),
    strong: ({ children }) => <strong className="font-semibold">{m(children)}</strong>,
    em: ({ children }) => <em>{m(children)}</em>,
    del: ({ children }) => <del className="opacity-60">{m(children)}</del>,

    h1: ({ children, node }) => (
      <h1 data-source-line={node?.position?.start.line} className="text-lg font-bold mb-2 mt-3 first:mt-0">
        {m(children)}
      </h1>
    ),
    h2: ({ children, node }) => (
      <h2 data-source-line={node?.position?.start.line} className="text-base font-bold mb-2 mt-3 first:mt-0">
        {m(children)}
      </h2>
    ),
    h3: ({ children, node }) => (
      <h3 data-source-line={node?.position?.start.line} className="text-sm font-bold mb-1 mt-2 first:mt-0">
        {m(children)}
      </h3>
    ),
    h4: ({ children, node }) => (
      <h4 data-source-line={node?.position?.start.line} className="text-sm font-semibold mb-1 mt-2 first:mt-0">
        {m(children)}
      </h4>
    ),
    h5: ({ children, node }) => (
      <h5
        data-source-line={node?.position?.start.line}
        className="text-xs font-semibold mb-1 mt-1.5 first:mt-0 uppercase tracking-wide"
      >
        {m(children)}
      </h5>
    ),
    h6: ({ children, node }) => (
      <h6
        data-source-line={node?.position?.start.line}
        className="text-xs font-medium mb-1 mt-1.5 first:mt-0 text-cafe-muted"
      >
        {m(children)}
      </h6>
    ),

    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children, className, node }) => (
      <li
        data-source-line={node?.position?.start.line}
        className={className === 'task-list-item' ? 'list-none -ml-5 flex items-start gap-1.5' : undefined}
      >
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

    blockquote: ({ children, node }) => (
      <blockquote
        data-source-line={node?.position?.start.line}
        className="border-l-[3px] border-cafe pl-3 my-2 italic opacity-80"
      >
        {children}
      </blockquote>
    ),
    a: ({ href, children, node }) => (
      <InsideMarkdownLinkContext.Provider value={true}>
        {referenceThreadId && typeof node?.properties?.['data-chat-reference'] === 'string' ? (
          <ChatReference
            reference={node.properties['data-chat-reference']}
            format={String(node.properties['data-chat-format'] ?? 'link')}
            layout={String(node.properties['data-chat-layout'] ?? 'inline')}
            threadId={referenceThreadId}
          >
            {m(children)}
          </ChatReference>
        ) : (
          <ChatWorkspaceLink href={href}>{m(children)}</ChatWorkspaceLink>
        )}
      </InsideMarkdownLinkContext.Provider>
    ),
    hr: () => <hr className="my-3 border-cafe" />,

    /* Code blocks with copy button — textProcessor intentionally excluded */
    pre: ({ children, node }) => (
      <div data-source-line={node?.position?.start.line}>
        {isMermaidPre(children) ? children : <CodeBlock>{children}</CodeBlock>}
      </div>
    ),
    code: ({ className = '', children }) =>
      hasMermaidLanguage(className) ? (
        <MermaidDiagram source={codeChildrenToString(children)} />
      ) : (
        <code className={inlineCodeClassName(className)}>{children}</code>
      ),

    /* Tables (GFM) */
    table: ({ children, node }) => (
      <div data-source-line={node?.position?.start.line} className="overflow-x-auto my-2">
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
  referenceThreadId?: string;
  className?: string;
  /** Skip slash-command prefix detection (e.g. for rich block bodyMarkdown) */
  disableCommandPrefix?: boolean;
  /** Base directory path for resolving relative links (e.g. "docs/features") */
  basePath?: string;
  /** Actual owner file, used only to return from a relative document link. */
  sourcePath?: string;
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
  referenceThreadId: sourceThreadId,
  className,
  disableCommandPrefix,
  basePath,
  sourcePath,
  worktreeId,
  textProcessor,
  listenSentences,
  activeListenAnchor,
  onListenSentenceStart,
}: Props) {
  const currentThreadId = useChatReferenceThread();
  const referenceThreadId = basePath == null ? (sourceThreadId ?? currentThreadId) : undefined;
  const referenceAnchor = useRef<HTMLDivElement>(null);
  const referenceDemand = useChatReferenceDemand(referenceAnchor, !!referenceThreadId);
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
    let nextComponents: Components =
      textProcessor || listen || referenceThreadId
        ? buildMdComponents(textProcessor, listen, referenceThreadId)
        : mdComponents;

    if (basePath != null) {
      // When textProcessor is active, the workspace link component must also compose it
      const mentionsFn = (children: ReactNode) => (
        <InsideMarkdownLinkContext.Provider value={true}>
          {textProcessor ? withMentions(textProcessor(children)) : withMentions(children)}
        </InsideMarkdownLinkContext.Provider>
      );
      nextComponents = {
        ...nextComponents,
        a: createWorkspaceLinkComponent(basePath, mentionsFn, worktreeId, sourcePath),
      };
      if (worktreeId) {
        nextComponents = { ...nextComponents, img: createWorkspaceImageComponent(basePath, worktreeId) };
      }
    }

    return nextComponents;
  }, [basePath, sourcePath, listen, textProcessor, worktreeId, referenceThreadId]);

  return (
    <ChatReferenceDemand.Provider value={referenceDemand}>
      <div ref={referenceAnchor} className={`markdown-content text-sm break-words ${className ?? ''}`}>
        {cmdMatch && <span className="font-semibold text-[var(--semantic-info)]">{cmdMatch[1]}</span>}
        <MarkdownSurface
          remarkPlugins={[
            ...(referenceThreadId ? [remarkChatReferences] : []),
            [remarkMath, { singleDollarTextMath: false }],
            ...(listenSentences?.length ? [createListenSentenceRemarkPlugin(listenSentences)] : []),
          ]}
          rehypePlugins={[rehypeKatex]}
          components={components}
          urlTransform={transformChatMarkdownUrl}
        >
          {md}
        </MarkdownSurface>
      </div>
    </ChatReferenceDemand.Provider>
  );
});
