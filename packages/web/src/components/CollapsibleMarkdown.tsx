'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { shouldFoldText, TEXT_FOLD_THRESHOLD } from '@/utils/textFold';
import { MarkdownContent } from './MarkdownContent';

const COLLAPSED_MAX_HEIGHT = 320;

export function CollapsibleMarkdown({ content, className }: { content: string; className?: string }) {
  const fold = shouldFoldText(content);
  const [expanded, setExpanded] = useState(false);
  const collapsed = fold && !expanded;
  const lineCount = content.split('\n').length;
  const hasMounted = useRef(false);

  useLayoutEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
    }
  }, [expanded]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  if (!fold) {
    return <MarkdownContent content={content} className={className} />;
  }

  return (
    <div>
      <div
        className="overflow-hidden transition-[max-height] duration-200"
        style={collapsed ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
      >
        <MarkdownContent content={content} className={className} />
      </div>
      <button
        type="button"
        onClick={toggle}
        className="mt-1 text-xs text-cafe-muted hover:text-cafe-primary transition-colors"
      >
        {collapsed ? `Show more (+${lineCount - TEXT_FOLD_THRESHOLD} lines)` : 'Show less'}
      </button>
    </div>
  );
}
