'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';

const DIVIDER = 'var(--console-border-strong)';

function ThinkingChevron({ expanded, color }: { expanded: boolean; color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || 'var(--cat-msg-inset-text)'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 transition-transform duration-150"
      style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/** Brain SVG — official lucide brain icon */
function BrainIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
      style={{ color: 'var(--cat-msg-inset-text)' }}
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

/** Collapsible thinking panel — same dark surface as CLI block, with brain SVG */
export function ThinkingContent({
  content,
  className,
  label = 'Thinking',
  defaultExpanded = false,
  expandInExport = true,
  breedColor,
}: {
  content: string;
  className?: string;
  label?: string;
  defaultExpanded?: boolean;
  expandInExport?: boolean;
  breedColor?: string;
}) {
  const isExport =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
  const shouldExpand = (isExport && expandInExport) || defaultExpanded;
  const [expanded, setExpanded] = useState(shouldExpand);
  const userInteracted = useRef(false);
  const hasMounted = useRef(false);
  useEffect(() => {
    if (!userInteracted.current) {
      setExpanded((isExport && expandInExport) || defaultExpanded);
    }
  }, [isExport, expandInExport, defaultExpanded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: expanded is intentional — dispatch on toggle
  useLayoutEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
    }
  }, [expanded]);
  const previewLength = 60;
  const preview = content.length > previewLength ? `${content.slice(0, previewLength)}…` : content;

  return (
    <div className="mt-2 mb-1 overflow-hidden" style={{ backgroundColor: 'var(--cat-msg-inset)', borderRadius: 10 }}>
      <button
        type="button"
        onClick={() => {
          userInteracted.current = true;
          setExpanded((v) => !v);
        }}
        className="w-full flex items-center gap-2 text-xs font-mono transition-colors"
        style={{ padding: '8px 12px', backgroundColor: 'var(--cat-msg-inset)' }}
      >
        <span style={{ color: breedColor || 'var(--cat-msg-inset-text)' }}>
          <ThinkingChevron expanded={expanded} color={breedColor} />
        </span>
        <BrainIcon />
        <span className="font-medium" style={{ color: 'var(--cat-msg-inset-text)' }}>
          {label}
        </span>
        {!expanded && (
          <span className="truncate max-w-[240px]" style={{ color: 'var(--cat-msg-inset-text)' }}>
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ backgroundColor: 'var(--cat-msg-inset)' }}>
          <div style={{ height: 1, backgroundColor: DIVIDER }} />
          <div
            style={{ padding: '8px 12px 10px 12px', color: 'var(--cat-msg-inset-text)' }}
            className="text-xs leading-relaxed cli-output-md"
          >
            <MarkdownContent content={content} className={className} />
          </div>
        </div>
      )}
    </div>
  );
}
