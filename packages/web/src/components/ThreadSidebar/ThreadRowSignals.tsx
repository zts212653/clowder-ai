'use client';

import { type ReactNode, useRef } from 'react';
import type { SidebarPresence, SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import { ThreadSignalCats } from './ThreadSignalCats';
import { threadSignalsCopy } from './thread-signals.shell-copy';
import { useSidebarSignalFlow, useWholeSidebarSignalText } from './use-measured-sidebar-rows';

interface RowSignalInput {
  presence: SidebarPresence;
  unreadCount: number;
  hasUserMention: boolean;
  hasDraft: boolean;
  hasPendingDecision?: boolean;
}

/** True when a v2 row has anything to say on its second line. */
export function hasThreadRowSignals(input: RowSignalInput): boolean {
  return (
    input.presence.status !== 'idle' ||
    input.unreadCount > 0 ||
    input.hasUserMention ||
    input.hasDraft ||
    Boolean(input.hasPendingDecision)
  );
}

export function sidebarStatusTextColor(role: 'info' | 'success' | 'warning' | 'critical'): string {
  return `color-mix(in srgb, var(--semantic-${role}) 75%, var(--shell-ink) 25%)`;
}

function PresenceLabel({
  label,
  tone,
  children,
  symbol,
  symbolAfter = false,
  textTestId,
  description,
}: {
  label: string;
  tone: 'info' | 'success' | 'critical';
  children?: ReactNode;
  symbol: ReactNode;
  symbolAfter?: boolean;
  textTestId?: string;
  description?: string;
}) {
  const slotRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const fits = useWholeSidebarSignalText(slotRef, contentRef, label);
  return (
    <AppTooltip
      label={description ?? label}
      side="right"
      intent="content"
      disabled={fits && !description}
      multiline={Boolean(description)}
    >
      <span
        role="img"
        aria-label={description ?? label}
        data-testid="thread-status-text"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The visible symbol recovers the whole hidden status by keyboard.
        tabIndex={0}
        className={`shell-focusable flex min-w-0 shrink items-center rounded-sm font-medium ${symbolAfter ? 'flex-1' : ''}`}
        style={{ color: sidebarStatusTextColor(tone) }}
      >
        {!symbolAfter && symbol}
        <span ref={slotRef} data-testid="thread-status-label" className="min-w-0 overflow-hidden">
          <span
            ref={contentRef}
            data-testid="thread-status-label-content"
            aria-hidden={!fits}
            className="inline-block whitespace-nowrap pl-1"
            style={{ visibility: fits ? 'visible' : 'hidden' }}
          >
            <span data-testid={textTestId} style={{ color: sidebarStatusTextColor(tone) }}>
              {children ?? label}
            </span>
          </span>
        </span>
        {symbolAfter && <span className="ml-1 flex-none">{symbol}</span>}
      </span>
    </AppTooltip>
  );
}

function executionDuration(
  activeSince: number | undefined,
  copy: { justNow: string; minute: string; hour: string; day: string },
): string {
  if (activeSince === undefined) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - activeSince) / 60_000));
  if (minutes === 0) return ` · ${copy.justNow}`;
  if (minutes >= 48 * 60) return ` · ${Math.floor(minutes / (24 * 60))} ${copy.day}`;
  if (minutes >= 60) return ` · ${Math.floor(minutes / 60)} ${copy.hour}`;
  return ` · ${minutes} ${copy.minute}`;
}

/** The single presence state; cats and timing come from the same canonical execution fact. */
function PresenceState({ presence }: { presence: SidebarPresence }) {
  const copy = useShellCopy(threadSignalsCopy);
  const cats = [...new Set(presence.cats ?? [])];
  const duration = executionDuration(presence.activeSince, copy);

  if (presence.status === 'error') {
    return (
      <span className="flex min-w-0 items-center" data-testid="thread-row-error">
        <PresenceLabel
          label={copy.error}
          tone="critical"
          symbol={
            <span
              aria-hidden="true"
              data-signal-fixed="error"
              className="h-2 w-2 flex-none rounded-full"
              style={{ background: 'var(--semantic-critical)' }}
            />
          }
        />
      </span>
    );
  }
  if (presence.status === 'working') {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1" data-testid="thread-row-working">
        {cats.length > 0 && <ThreadSignalCats cats={cats} />}
        <span className="flex min-w-0 shrink items-center whitespace-nowrap" data-testid="thread-working-state">
          <PresenceLabel
            label={`${copy.working}${duration}`}
            tone="info"
            symbol={
              <span
                aria-hidden="true"
                data-testid="thread-running-cat"
                data-signal-fixed="working"
                className="inline-block h-4 flex-none font-normal leading-4 animate-cat-bounce motion-reduce:animate-none"
                style={{ color: 'var(--semantic-info)' }}
              >
                ᓚᘏᗢ
              </span>
            }
          >
            <span data-testid="thread-working-label">{copy.working}</span>
            {duration && (
              <span className="tabular-nums" data-testid="thread-working-duration">
                {duration}
              </span>
            )}
          </PresenceLabel>
        </span>
      </span>
    );
  }
  if (presence.status === 'done') {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1" data-testid="thread-row-done">
        {cats.length > 0 && <ThreadSignalCats cats={cats} />}
        <span className="flex min-w-0 shrink items-center whitespace-nowrap">
          <PresenceLabel label={copy.replied} tone="success" symbol={<RepliedSymbol prefix="thread" />} />
        </span>
      </span>
    );
  }
  return null;
}

function RepliedSymbol({ prefix }: { prefix: 'thread' | 'group' }) {
  return (
    <span data-signal-fixed="replied" className="inline-flex flex-none items-center gap-1">
      <span
        aria-hidden="true"
        data-testid={`${prefix}-replied-cat`}
        className="inline-block h-4 flex-none font-normal leading-4"
        style={{ color: 'var(--semantic-success)' }}
      >
        ᓚᘏᗢ
      </span>
      <svg
        data-testid={`${prefix}-replied-check`}
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke="var(--semantic-success)"
        strokeWidth="2"
      >
        <path d="m3 8 3 3 7-7" />
      </svg>
    </span>
  );
}

/** Render-only summary of the same member presence; attention badges never imply a state. */
export function CollapsedGroupPresence({ members }: { members: readonly SidebarSnapshotRow[] }) {
  const copy = useShellCopy(threadSignalsCopy);
  const working = members.filter((member) => member.presence.status === 'working');
  if (working.length > 0) {
    const cats = [...new Set(working.flatMap((member) => member.presence.cats ?? []))];
    const label = cats.length > 0 ? copy.catsWorking(cats.length) : copy.working;
    return (
      <span className="flex min-w-0 flex-1 items-center">
        {cats.length > 0 && <ThreadSignalCats cats={cats} showNames={false} />}
        <PresenceLabel
          label={label}
          tone="info"
          textTestId="group-working-label"
          symbolAfter
          symbol={
            <span
              aria-hidden="true"
              data-testid="group-running-cat"
              data-signal-fixed="working"
              className="inline-block h-4 shrink-0 font-normal leading-4 animate-cat-bounce motion-reduce:animate-none"
              style={{ color: 'var(--semantic-info)' }}
            >
              ᓚᘏᗢ
            </span>
          }
        />
      </span>
    );
  }
  const failedMembers = members.filter((member) => member.presence.status === 'error');
  const errors = failedMembers.length;
  const replies = members.filter((member) => member.presence.status === 'done').length;
  if (errors === 0 && replies === 0) return null;
  // SidebarPresence has no awaiting-human fact: do not infer one from unread or @you.
  return (
    <span className="flex min-w-0 flex-1 items-center" data-testid="group-presence-summary">
      <PresenceLabel
        label={errors > 0 ? copy.groupErrors(errors) : copy.groupReplied(replies)}
        description={
          errors > 0
            ? copy.groupErrorDetails(errors, failedMembers.map((member) => member.title || copy.untitled).join('\n'))
            : undefined
        }
        tone={errors > 0 ? 'critical' : 'success'}
        symbol={
          errors > 0 ? (
            <span
              aria-hidden="true"
              data-testid="group-error-dot"
              data-signal-fixed="error"
              className="h-2 w-2 flex-none rounded-full"
              style={{ background: 'var(--semantic-critical)' }}
            />
          ) : (
            <RepliedSymbol prefix="group" />
          )
        }
      />
    </span>
  );
}

const PILL = 'inline-flex h-4 flex-none items-center rounded-full px-1.5 text-label font-semibold leading-none';

/** @你 and unread are independent of the presence state on the left. */
export function ThreadSignalPills({
  unreadCount,
  hasUserMention,
  mentionCount,
  hasDraft = false,
  hasPendingDecision = false,
  testIdPrefix = 'thread-row',
}: {
  unreadCount: number;
  hasUserMention: boolean;
  mentionCount?: number;
  hasDraft?: boolean;
  hasPendingDecision?: boolean;
  testIdPrefix?: string;
}) {
  const copy = useShellCopy(threadSignalsCopy);
  if (!hasDraft && !hasUserMention && unreadCount === 0 && !hasPendingDecision) return null;
  const unreadText = unreadCount > 99 ? '99+' : String(unreadCount);
  return (
    <div
      className="ml-auto flex max-w-full flex-none flex-wrap items-center justify-end gap-1"
      data-testid={`${testIdPrefix}-pills`}
    >
      {hasPendingDecision && (
        <span data-signal-badge className="inline-flex h-5 flex-none items-center gap-1">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: 'var(--semantic-warning)' }}
          />
          <span
            role="img"
            aria-label={copy.needsDecision}
            className="text-label font-medium"
            style={{ color: sidebarStatusTextColor('warning') }}
            data-testid="thread-row-pending-decision"
          >
            {copy.needsDecision}
          </span>
        </span>
      )}
      {hasDraft && (
        <span data-signal-badge className="inline-flex h-5 flex-none items-center">
          <span
            role="img"
            aria-label={copy.draft}
            className="inline-flex h-5 flex-none items-center rounded border px-1 text-[var(--shell-muted)]"
            style={{ borderColor: 'var(--shell-hairline)' }}
            data-testid="thread-row-draft"
          >
            {copy.draft}
          </span>
        </span>
      )}
      {hasUserMention && (
        <span data-signal-badge className="inline-flex h-5 flex-none items-center">
          <span
            className={PILL}
            style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
            data-testid={`${testIdPrefix}-mention`}
          >
            {copy.mention}
            {mentionCount !== undefined ? ` ${mentionCount}` : ''}
          </span>
        </span>
      )}
      {unreadCount > 0 && (
        <span data-signal-badge className="inline-flex h-5 flex-none items-center">
          <span
            className={PILL}
            style={{ background: 'var(--shell-primary-soft)', color: 'var(--shell-primary-text)' }}
            role="img"
            aria-label={`${unreadCount} ${copy.unread}`}
            data-testid={`${testIdPrefix}-unread`}
          >
            {unreadText} {copy.unreadBadge}
          </span>
        </span>
      )}
    </div>
  );
}

/** Reflow whole fixed facts; text visibility never feeds back into the line-count decision. */
export function SidebarSignalLayout({
  presence,
  badges,
  testId,
}: {
  presence?: ReactNode;
  badges: ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { split, presenceMinimum } = useSidebarSignalFlow(ref, presence, badges);
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-signal-split={split}
      className={`mt-1 flex min-h-5 min-w-0 gap-1 whitespace-nowrap text-xs leading-5 ${split ? 'flex-col' : 'items-center'}`}
    >
      {presence && (
        <div
          data-signal-presence
          className={`flex h-5 items-center ${split ? 'w-full' : 'flex-1'}`}
          style={{ minWidth: presenceMinimum, color: 'var(--shell-muted)' }}
        >
          {presence}
        </div>
      )}
      {badges}
    </div>
  );
}

/** Canonical presence on the left; independent badges flow right. Optional words yield first. */
export function ThreadRowSignals(props: RowSignalInput) {
  if (!hasThreadRowSignals(props)) return null;
  const { presence, unreadCount, hasUserMention, hasDraft, hasPendingDecision } = props;
  const hasPresence = presence.status !== 'idle';
  return (
    <SidebarSignalLayout
      testId="thread-row-signals"
      presence={hasPresence ? <PresenceState presence={presence} /> : null}
      badges={
        <ThreadSignalPills
          unreadCount={unreadCount}
          hasUserMention={hasUserMention}
          hasDraft={hasDraft}
          hasPendingDecision={hasPendingDecision}
        />
      }
    />
  );
}
