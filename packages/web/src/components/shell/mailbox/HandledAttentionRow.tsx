import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { formatApprovalRelativeTime } from '@/lib/approval-presentation';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { handledHistoryCopy } from './handled-history.shell-copy';
import { MailboxRow } from './MailboxRow';
import type { OriginalPlace } from './original-place';
import type { MailboxPersonalActions } from './use-mailbox-personal-preferences';

export function HandledAttentionRow({
  item,
  ignored,
  readCurrent,
  personal,
  onOpenPlace,
  selection,
  at,
}: {
  item: UnifiedAttentionItemV1;
  ignored: boolean;
  readCurrent: boolean;
  personal?: MailboxPersonalActions;
  onOpenPlace: (place: OriginalPlace) => void;
  at: number;
  selection?: { checked: boolean; disabled: boolean; toggle: () => void };
}) {
  const [expanded, setExpanded] = useState(false);
  const t = useShellCopy(handledHistoryCopy),
    language = useShellLanguage();
  const resolveName = useCatNameResolver();
  const mention = item.userMention;
  const label =
    ignored || mention?.handledReason === 'ignored'
      ? t.ignoredResult
      : mention?.handledReason === 'replied'
        ? t.replied
        : mention?.handledReason === 'viewed'
          ? t.viewed
          : t.handledJustNow;
  const title = mention ? [mention.content, mention.threadTitle].filter(Boolean).join(' · ') : item.summary;
  return (
    <li
      data-testid="mailbox-history-row"
      data-decision-ref={item.decisionRef}
      className="border-b py-3"
      style={{ borderColor: 'var(--shell-hairline)' }}
    >
      <div className="flex items-start gap-2">
        {selection ? (
          <input
            type="checkbox"
            aria-label={title}
            checked={selection.checked}
            disabled={selection.disabled}
            onChange={selection.toggle}
          />
        ) : null}
        <button
          type="button"
          data-testid="mailbox-history-item-toggle"
          aria-expanded={expanded}
          className="shell-focusable min-w-0 flex-1 text-left text-sm"
          onClick={() => setExpanded(!expanded)}
        >
          <span
            className="mr-2 inline-block h-2 w-2 rounded-full"
            style={{ background: ignored ? 'var(--shell-muted)' : 'var(--semantic-info)' }}
          />
          {label}
          <span className="ml-2 text-xs text-[var(--shell-muted)]">{mention ? t.mentions : t.decisions}</span>
          <span className="float-right text-xs text-[var(--shell-muted)]">
            {at ? formatApprovalRelativeTime(at, Date.now(), language) : t.unknownTime}
          </span>
          <span className="mt-1 block break-words text-[var(--shell-body)]">
            {title}
            {mention ? ` · ${resolveName(mention.catId)}` : ''}
          </span>
        </button>
      </div>
      {expanded ? (
        <ul className="m-0 mt-2 list-none p-0">
          <MailboxRow
            item={item}
            rowKey={item.decisionRef}
            expanded
            onToggle={() => setExpanded(false)}
            onOpen={onOpenPlace}
            stale={!readCurrent}
            readCurrent={readCurrent}
            personal={ignored ? personal : undefined}
          />
        </ul>
      ) : null}
    </li>
  );
}
