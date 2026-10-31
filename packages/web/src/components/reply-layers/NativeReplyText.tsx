import { CollapsibleMarkdown } from '../CollapsibleMarkdown';
import type { ReplyOutputText } from './reply-output';
import { registerReplyOutputSelectionSource } from './reply-output-selection';

/** Presentation slices retain their source ranges; the stored body stays whole. */
export function NativeReplyText({
  run,
  disclosureKey,
  className,
  process = false,
}: {
  run: ReplyOutputText;
  disclosureKey?: string;
  className?: string;
  process?: boolean;
}) {
  return (
    <div
      ref={(node) => {
        if (node) registerReplyOutputSelectionSource(node, run);
      }}
      data-reply-output-run={run.id}
      data-reply-output-kind={process ? 'process' : 'answer'}
      data-context-quote-source="message"
      data-source-content-start={run.start}
      data-source-content-end={run.end}
    >
      <CollapsibleMarkdown
        content={run.text}
        className={className}
        disclosureKey={disclosureKey ? `${disclosureKey}:native:${run.id}` : undefined}
      />
    </div>
  );
}
