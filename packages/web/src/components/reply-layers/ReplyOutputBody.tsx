'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { dispatchChatLayoutChanged } from '@/utils/chat-layout-change';
import { useShellCopy } from '../shell/shell-copy';
import { NativeReplyText } from './NativeReplyText';
import { processTalkCopy } from './process-talk.shell-copy';
import type { ReplyOutputProjection } from './reply-output';

export function ReplyOutputBody({
  output,
  className,
  disclosureKey,
}: {
  output: ReplyOutputProjection;
  className?: string;
  disclosureKey?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const t = useShellCopy(processTalkCopy);
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: notify the reading owner after a disclosure commits.
  useLayoutEffect(() => {
    if (mounted.current) dispatchChatLayoutChanged();
    mounted.current = true;
  }, [expanded]);
  return (
    <div data-testid="native-reply-answer" className="space-y-3">
      {output.showEarlierText && output.processCount > 0 && (
        <div>
          <button
            type="button"
            data-testid="reply-earlier-toggle"
            data-reading-disclosure
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded((value) => !value)}
            className="shell-focusable rounded text-sm hover:underline"
            style={{ color: 'var(--shell-muted)' }}
          >
            {t.earlier(output.processCount)} <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
          </button>
          {expanded && (
            <div
              id={id}
              data-testid="reply-earlier-text"
              className="mt-2 space-y-3 border-b border-cafe pb-3 text-cafe-secondary"
            >
              {output.record.map((entry) =>
                entry.kind === 'text' ? (
                  <NativeReplyText
                    key={entry.id}
                    run={entry}
                    className={className}
                    disclosureKey={disclosureKey}
                    process
                  />
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
      {output.answers.map((run) => (
        <NativeReplyText key={run.id} run={run} className={className} disclosureKey={disclosureKey} />
      ))}
    </div>
  );
}
