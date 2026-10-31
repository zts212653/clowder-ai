'use client';

import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import type { GroupPeekProjection } from './collapsed-group-peek';
import { sidebarStatusTextColor, ThreadSignalPills } from './ThreadRowSignals';
import { threadSignalsCopy } from './thread-signals.shell-copy';

/** A shortcut to existing conversation navigation while retaining the collapsed Group. */
export function CollapsedGroupPeek({
  peek,
  currentId,
  onSelect,
  onExpand,
}: {
  peek: GroupPeekProjection;
  currentId: string | null;
  onSelect: (threadId: string) => void;
  onExpand: () => void;
}) {
  const copy = useShellCopy(threadSignalsCopy);
  return (
    <div data-testid="collapsed-group-peek" className="mt-1 min-w-0 pl-10">
      {peek.entries.map(({ member, reason }) => {
        const title = member.title?.trim() || copy.untitled;
        const label =
          reason === 'decision'
            ? copy.needsDecision
            : reason === 'mention'
              ? copy.mention
              : `${member.unreadCount} ${copy.unreadBadge}`;
        return (
          <AppTooltip key={member.id} label={`${title} · ${label}`} side="right" intent="content">
            <button
              type="button"
              data-thread-id={member.id}
              data-peek-reason={reason}
              aria-current={member.id === currentId ? 'page' : undefined}
              aria-label={`${title} · ${label}`}
              onClick={() => onSelect(member.id)}
              className="shell-focusable flex min-h-7 w-full min-w-0 items-center gap-1 rounded-md text-left text-xs"
              style={{
                color: 'var(--shell-body)',
                background: member.id === currentId ? 'var(--shell-selected)' : undefined,
              }}
            >
              <span className="min-w-0 flex-1 truncate" data-testid="group-peek-title">
                {title}
              </span>
              {reason === 'decision' ? (
                <span
                  className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap font-medium"
                  style={{ color: sidebarStatusTextColor('warning') }}
                  data-testid="group-peek-label"
                >
                  <span
                    aria-hidden="true"
                    data-testid="group-peek-decision-dot"
                    className="h-2 w-2 flex-none rounded-full"
                    style={{ background: 'var(--semantic-warning)' }}
                  />
                  {label}
                </span>
              ) : (
                <div className="flex h-5 shrink-0 items-center" data-testid="group-peek-label">
                  <ThreadSignalPills
                    unreadCount={reason === 'unread' ? member.unreadCount : 0}
                    hasUserMention={reason === 'mention'}
                    testIdPrefix="group-peek"
                  />
                </div>
              )}
            </button>
          </AppTooltip>
        );
      })}
      {peek.total > peek.entries.length && (
        <button
          type="button"
          onClick={onExpand}
          className="shell-focusable h-7 w-full min-w-0 truncate rounded text-left text-xs"
          style={{ color: 'var(--shell-muted)' }}
          data-testid="group-peek-more"
        >
          {copy.moreToSee(peek.total - peek.entries.length)}
        </button>
      )}
    </div>
  );
}
