import { COLLECTIVE_REACTION_EMOJIS } from '@cat-cafe/shared';
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CollectiveIcon } from './CollectiveIcon.js';
import type { CollectiveReactionEmoji } from './client-types.js';

type OpenPanel = 'menu' | 'reactions';

export function MessageActionBar({
  eventLabel,
  activeReactions,
  pendingReaction,
  reactionTriggerRef,
  moreTriggerRef,
  onSetReaction,
  onReply,
  onMention,
  onStartVote,
  onProposeWork,
}: {
  readonly eventLabel: string;
  readonly activeReactions: ReadonlySet<CollectiveReactionEmoji>;
  readonly pendingReaction?: CollectiveReactionEmoji;
  readonly reactionTriggerRef: RefObject<HTMLButtonElement>;
  readonly moreTriggerRef: RefObject<HTMLButtonElement>;
  readonly onSetReaction?: (emoji: CollectiveReactionEmoji, active: boolean, returnFocus?: HTMLElement | null) => void;
  readonly onReply?: () => void;
  readonly onMention?: () => void;
  readonly onStartVote?: () => void;
  readonly onProposeWork?: () => void;
}) {
  const [open, setOpen] = useState<OpenPanel>();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousPendingReactionRef = useRef(pendingReaction);
  const menuId = useId();
  const reactionId = useId();
  const canReact = Boolean(onSetReaction);
  const hasMenu = canReact || Boolean(onReply || onMention || onStartVote || onProposeWork);

  useEffect(() => {
    if (!open) return;
    const opener = moreTriggerRef.current;
    const close = () => {
      setOpen(undefined);
      queueMicrotask(() => opener?.focus());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onOutsidePress);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onOutsidePress);
    };
  }, [moreTriggerRef, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root) return;
    if (!panel) return;
    const scrollBoundary = root.closest<HTMLElement>('.channel-flow, .topic-flow');
    const positionPanel = () => {
      const rootBox = root.getBoundingClientRect();
      const boundaryBox = scrollBoundary
        ? scrollBoundary.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight };
      const safeTop = Math.max(0, boundaryBox.top) + 4;
      const safeBottom = Math.min(window.innerHeight, boundaryBox.bottom) - 4;
      const spaceAbove = Math.max(0, rootBox.top - safeTop - 4);
      const spaceBelow = Math.max(0, safeBottom - rootBox.bottom - 4);
      const placement = spaceBelow >= panel.scrollHeight ? 'below' : spaceBelow >= spaceAbove ? 'below' : 'above';
      const available = placement === 'above' ? spaceAbove : spaceBelow;
      panel.dataset.placement = placement;
      panel.style.setProperty('--message-panel-max-height', `${Math.max(44, Math.floor(available))}px`);
    };
    positionPanel();
    scrollBoundary?.addEventListener('scroll', positionPanel, { passive: true });
    window.addEventListener('resize', positionPanel);
    return () => {
      scrollBoundary?.removeEventListener('scroll', positionPanel);
      window.removeEventListener('resize', positionPanel);
    };
  }, [open]);

  useEffect(() => {
    if (previousPendingReactionRef.current === pendingReaction) return;
    previousPendingReactionRef.current = pendingReaction;
    setOpen(undefined);
    queueMicrotask(() => moreTriggerRef.current?.focus());
  }, [moreTriggerRef, pendingReaction]);

  const run = (action: (() => void) | undefined) => {
    setOpen(undefined);
    action?.();
  };

  return (
    <div ref={rootRef} className="message-actions" role="toolbar" aria-label="消息操作">
      {canReact && (
        <button
          ref={reactionTriggerRef}
          type="button"
          className="message-action-primary"
          aria-label="添加回应"
          aria-expanded={open === 'reactions'}
          aria-controls={open === 'reactions' ? reactionId : undefined}
          disabled={pendingReaction !== undefined}
          onClick={() => setOpen((current) => (current === 'reactions' ? undefined : 'reactions'))}
        >
          <CollectiveIcon kind="reaction" />
        </button>
      )}
      {onReply && (
        <button
          type="button"
          className="message-action-primary"
          aria-label={`回复 ${eventLabel}`}
          onClick={() => run(onReply)}
        >
          <CollectiveIcon kind="reply" />
        </button>
      )}
      {hasMenu && (
        <button
          ref={moreTriggerRef}
          type="button"
          className="message-action-more"
          aria-label="更多消息动作"
          aria-expanded={open === 'menu'}
          aria-controls={open === 'menu' ? menuId : undefined}
          onClick={() => setOpen((current) => (current === 'menu' ? undefined : 'menu'))}
        >
          <CollectiveIcon kind="more" />
        </button>
      )}
      {open === 'reactions' && onSetReaction && (
        <div ref={panelRef} id={reactionId} className="reaction-picker" role="toolbar" aria-label="选择回应">
          {COLLECTIVE_REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`用 ${emoji} 回应`}
              aria-pressed={activeReactions.has(emoji)}
              disabled={pendingReaction !== undefined}
              onClick={() => {
                setOpen(undefined);
                onSetReaction(emoji, !activeReactions.has(emoji), moreTriggerRef.current);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {open === 'menu' && (
        <div ref={panelRef} id={menuId} className="message-action-menu" role="menu" aria-label="更多消息动作">
          {canReact && (
            <button type="button" role="menuitem" onClick={() => setOpen('reactions')}>
              用表情回应
            </button>
          )}
          {onReply && (
            <button type="button" role="menuitem" onClick={() => run(onReply)}>
              回复 {eventLabel}
            </button>
          )}
          {onMention && (
            <button type="button" role="menuitem" onClick={() => run(onMention)}>
              提到 {eventLabel}
            </button>
          )}
          {onStartVote && (
            <button type="button" role="menuitem" onClick={() => run(onStartVote)}>
              发起随手投票
            </button>
          )}
          {onProposeWork && (
            <button type="button" role="menuitem" onClick={() => run(onProposeWork)}>
              整理为工作
            </button>
          )}
        </div>
      )}
    </div>
  );
}
