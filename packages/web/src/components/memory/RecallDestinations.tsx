import Link from 'next/link';
import { ExternalLinkIcon } from '@/components/HubConfigIcons';
import { openSourcePlace } from '@/components/shell/mailbox/open-exact-place';
import { useWorkspaceChatReveal } from '@/components/workbench/WorkspaceChatReveal';
import { recallResultHref, recallResultTitle } from '@/hooks/recall-display';
import type { RecallResultItem } from '@/hooks/recall-types';

export function RecallDestinations({ item }: { item: RecallResultItem }) {
  const revealChat = useWorkspaceChatReveal();
  if (item.titleStatus || item.sourceUnavailableReason) return null;
  const typed = item.memoryHref !== undefined || item.messageHref !== undefined;
  const links = typed
    ? [
        { href: item.messageHref, label: '查看原消息' },
        { href: item.memoryHref, label: '在记忆页打开' },
      ]
    : [{ href: recallResultHref(item), label: item.sourceType === 'matter' ? '在记忆页打开' : '打开' }];
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-2">
      {links
        .filter(
          (link): link is { href: string; label: string } => typeof link.href === 'string' && link.href.length > 0,
        )
        .map(({ href, label }) => (
          <Link
            key={label}
            href={href}
            className="inline-flex items-center gap-1 text-cafe-accent hover:underline"
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              const source = /^\/thread\/([A-Za-z0-9_-]{1,200})\?message=([A-Za-z0-9_-]{1,200})$/.exec(href ?? '');
              if (!source) return;
              event.preventDefault();
              revealChat?.(source[1]);
              openSourcePlace(`message:${source[1]}:${source[2]}`, window.location.pathname);
            }}
          >
            {label}
            <ExternalLinkIcon />
            <span className="sr-only"> {recallResultTitle(item)}</span>
          </Link>
        ))}
    </span>
  );
}
