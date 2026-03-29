'use client';

import { Children, type ReactNode, useCallback, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { getMentionColor, getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { useChatStore } from '@/stores/chatStore';
import { createWorkspaceImageComponent, createWorkspaceLinkComponent } from './workspace-md-components';

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
    const catColor = colorMap[catId] ?? '#9B7EBD';
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
        className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-cafe-muted md:opacity-0 md:group-hover:opacity-100 hover:bg-gray-600 transition-opacity"
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre
        ref={preRef}
        className="bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto text-xs leading-5 font-mono [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit [&>code]:text-xs"
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
        <span key={`fp${m.index}`} className="text-blue-400 font-mono text-[0.85em]">
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
      className="text-blue-400 hover:text-blue-300 hover:underline font-mono text-[0.85em] cursor-pointer"
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

/* ── Markdown component overrides ──────────────────────────── */
const mdComponents: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{withMentionsAndLinks(children)}</p>,
  strong: ({ children }) => <strong className="font-semibold">{withMentions(children)}</strong>,
  em: ({ children }) => <em>{withMentions(children)}</em>,
  del: ({ children }) => <del className="opacity-60">{withMentions(children)}</del>,

  h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{withMentions(children)}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{withMentions(children)}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{withMentions(children)}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{withMentions(children)}</h4>,
  h5: ({ children }) => (
    <h5 className="text-xs font-semibold mb-1 mt-1.5 first:mt-0 uppercase tracking-wide">{withMentions(children)}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-xs font-medium mb-1 mt-1.5 first:mt-0 text-gray-500">{withMentions(children)}</h6>
  ),

  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children, className }) => (
    <li className={className === 'task-list-item' ? 'list-none -ml-5 flex items-start gap-1.5' : undefined}>
      {withMentions(children)}
    </li>
  ),
  input: ({ type, checked }) =>
    type === 'checkbox' ? (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="mt-1 h-3.5 w-3.5 rounded border-gray-300 text-blue-500 pointer-events-none"
      />
    ) : (
      <input type={type} />
    ),

  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-cafe pl-3 my-2 italic opacity-80">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline break-all">
      {withMentions(children)}
    </a>
  ),
  hr: () => <hr className="my-3 border-cafe" />,

  /* Code blocks with copy button */
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => (
    <code className={`${className ?? ''} bg-gray-200/50 rounded px-1 py-0.5 text-[0.85em] font-mono`}>{children}</code>
  ),

  /* Tables (GFM) */
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-cafe-surface-elevated">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-cafe px-2 py-1 text-left font-semibold text-xs">{withMentions(children)}</th>
  ),
  td: ({ children }) => <td className="border border-cafe px-2 py-1">{withMentions(children)}</td>,
};

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
  const clean = relative.split('#')[0];
  // base is the directory of the current file (e.g. "docs/features")
  const parts = base ? base.split('/') : [];
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function MarkdownContent({ content, className, disableCommandPrefix, basePath, worktreeId }: Props) {
  const cmdMatch = disableCommandPrefix ? null : /^(\/\w+)/.exec(content);
  const md = cmdMatch ? content.slice(cmdMatch[1].length) : content;

  let components = mdComponents;
  if (basePath != null) {
    components = { ...components, a: createWorkspaceLinkComponent(basePath, withMentions) };
    if (worktreeId) {
      components = { ...components, img: createWorkspaceImageComponent(basePath, worktreeId) };
    }
  }

  return (
    <div className={`markdown-content text-sm break-words ${className ?? ''}`}>
      {cmdMatch && <span className="font-semibold text-indigo-500">{cmdMatch[1]}</span>}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {md}
      </ReactMarkdown>
    </div>
  );
}
