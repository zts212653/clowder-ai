import type { ReactNode } from 'react';
import { useTts } from '@/hooks/useTts';
import type { ChatMessage } from '@/stores/chat-types';
import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import { MessageActionScope } from './message-action-ownership';
import { messageActionsCopy } from './message-actions-copy';

const paths = {
  select: 'M3 4h6v6H3zM3 14h6v6H3zM13 7h8M13 17h8m-16-10 1 1 2-2',
  reply: 'M3 10h10a5 5 0 015 5v6M3 10l6-6M3 10l6 6',
  trajectory: 'M5 6v8a4 4 0 004 4h8M3 3h4v4H3zM17 17h4v4h-4z',
  read: 'm7 4 13 8L7 20z',
  stop: 'M7 4v16M17 4v16',
  remove: 'M4 7h16M7 7l1 14h8l1-14M9 7V3h6v4',
  more: 'M5 11v2M12 11v2M19 11v2',
};
type Icon = keyof typeof paths;

function DockAction({
  label,
  icon,
  onClick,
  disabled,
  expanded,
}: {
  label: string;
  icon: Icon;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <AppTooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        aria-expanded={expanded}
        aria-haspopup={expanded === undefined ? undefined : 'menu'}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-cafe-muted hover:bg-cafe-surface-elevated hover:text-cafe-primary disabled:opacity-40"
        onClick={onClick}
      >
        <svg
          aria-hidden="true"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
        >
          <path d={paths[icon]} />
        </svg>
      </button>
    </AppTooltip>
  );
}

interface Props {
  message: ChatMessage;
  positionClass: string;
  visibilityClass: string;
  compact: boolean;
  canAct: boolean;
  isUser: boolean;
  onSelect?: () => void;
  onReply: () => void;
  onTrajectory?: () => void;
  onDelete: () => void;
  onMore: () => void;
  overflowOpen: boolean;
  showDropdown: boolean;
  overflowItems: ReactNode;
  overlay?: boolean;
  onCompactClose?: () => void;
}

function OverflowMenu({
  label,
  overlay,
  isUser,
  children,
}: {
  label: string;
  overlay: boolean;
  isUser: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="menu"
      aria-label={label}
      data-message-actions-menu
      style={overlay ? { position: 'fixed', visibility: 'hidden' } : undefined}
      className={`${overlay ? 'fixed' : 'absolute top-full mt-1'} z-40 w-44 rounded-lg border border-cafe bg-cafe-surface py-1 shadow-sm ${isUser ? 'right-0' : 'left-0'}`}
    >
      {children}
    </div>
  );
}

/** The existing action owner's paint, anchored to the zero-size author slot. */
export function MessageActionsDock({
  message,
  positionClass,
  visibilityClass,
  compact,
  canAct,
  isUser,
  onSelect,
  onReply,
  onTrajectory,
  onDelete,
  onMore,
  overflowOpen,
  showDropdown,
  overflowItems,
  overlay = false,
  onCompactClose,
}: Props) {
  const t = useShellCopy(messageActionsCopy);
  const voice = useTts();
  const active = voice.activeMessageId === message.id;
  const speaks = !isUser && !!message.catId && message.content.trim().length > 0 && !message.isStreaming;
  return (
    <MessageActionScope value="anchor">
      <div
        role="toolbar"
        aria-label={t.actions}
        data-quote-exclude
        data-testid="message-actions-toolbar"
        className={`${visibilityClass} ${compact ? 'relative' : positionClass} z-30 flex gap-0.5 rounded-lg border border-cafe bg-cafe-surface/95 px-1 py-0.5 shadow-sm ${compact ? 'w-full flex-wrap justify-center [&_button]:min-h-11 [&_button]:min-w-11' : ''}`}
        onClick={compact ? onCompactClose : undefined}
      >
        {onSelect && <DockAction label={t.select} icon="select" onClick={onSelect} />}
        <DockAction label={t.reply} icon="reply" onClick={onReply} />
        {onTrajectory && <DockAction label={t.trajectory} icon="trajectory" onClick={onTrajectory} />}
        {speaks && (
          <DockAction
            label={active && voice.state === 'playing' ? t.stop : t.read}
            icon={active && voice.state === 'playing' ? 'stop' : 'read'}
            disabled={active && voice.state === 'loading'}
            onClick={() => voice.synthesize(message.id, message.content, message.catId)}
          />
        )}
        {canAct && (
          <>
            <DockAction label={t.remove} icon="remove" onClick={onDelete} />
            <div className="relative">
              <DockAction label={t.more} icon="more" onClick={onMore} expanded={overflowOpen} />
              {showDropdown && (
                <OverflowMenu label={t.more} overlay={overlay} isUser={isUser}>
                  {overflowItems}
                </OverflowMenu>
              )}
            </div>
          </>
        )}
      </div>
    </MessageActionScope>
  );
}
