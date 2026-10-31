'use client';

import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MessageActionOwnership } from './message-action-ownership';
import { boundedMenuPosition } from './message-actions-menu-geometry';
import {
  authorFacts,
  boundedActionPosition,
  messageIsReadable,
  needsCompactControl,
  readActionPort,
} from './message-actions-overlay-geometry';
import {
  type ActionPlaneEntry,
  hideActionPlane,
  refreshActionPlane,
  registerActionPlane,
} from './message-actions-overlay-scheduler';
import { positionActionPlane, settleActionMenu, settleActionPlane } from './message-actions-plane-commit';

/** The author slot owns meaning; this plane owns paint outside the message's scroll geometry. */
export function MessageActionsOverlay({
  owner,
  anchor,
  messageId,
  isUser,
  expanded,
  surfaceVersion,
  ownership,
  onMenuUnavailable,
  onSettled,
  onCompactChange,
  children,
}: {
  owner: RefObject<HTMLDivElement | null>;
  anchor: HTMLDivElement;
  messageId: string;
  isUser: boolean;
  expanded: boolean;
  surfaceVersion: string;
  ownership: MessageActionOwnership;
  onMenuUnavailable: () => void;
  onSettled: (plane: HTMLElement) => void;
  onCompactChange: (compact: boolean) => void;
  children: (compact: boolean) => ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touch, setTouch] = useState(false);
  const plane = useRef<HTMLDivElement>(null);
  const fullWidth = useRef(0);
  const fullHeight = useRef(0);
  const columnRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => setHost(document.body), []);
  useEffect(() => () => ownership.settle(false, false), [ownership]);

  useLayoutEffect(() => {
    if (!host) return;
    const node = plane.current;
    const row = owner.current;
    if (!node || !row) return;
    const column = row.closest<HTMLElement>('[data-thread-chat-reading-column]') ?? row;
    const port = column.closest<HTMLElement>('[data-chat-container]');
    columnRef.current = column;
    const initialControl = node.firstElementChild?.getBoundingClientRect();
    const entry: ActionPlaneEntry = {
      row,
      node,
      width: initialControl?.width ?? 0,
      authorLine: anchor.parentElement,
      suspend() {
        hideActionPlane(node);
        ownership.pending(() => messageIsReadable(row, readActionPort(port)));
      },
      retire() {
        hideActionPlane(node);
        ownership.settle(false, false);
      },
      measure(context) {
        const slot = anchor.getBoundingClientRect();
        const control = node.firstElementChild?.getBoundingClientRect();
        if (!control) return () => entry.retire();
        entry.width = control.width;
        if (!compact) {
          fullWidth.current = control.width;
          fullHeight.current = control.height;
        }
        const facts = authorFacts(anchor);
        const position = boundedActionPosition(slot, context.column, control, context.port, facts, isUser, compact);
        const fullSize = { width: fullWidth.current, height: fullHeight.current };
        const nextCompact = needsCompactControl(slot, context.column, fullSize, facts, isUser, context.compact);
        const messageAvailable = messageIsReadable(row, context.port);
        const available = position.available && messageAvailable;
        const menu = node.querySelector<HTMLElement>('[data-message-actions-menu]');
        const menuAnchor = node.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.getBoundingClientRect();
        const menuPosition =
          menu && menuAnchor
            ? boundedMenuPosition(
                new DOMRect(
                  menuAnchor.left + position.left - control.left,
                  menuAnchor.top + position.top - control.top,
                  menuAnchor.width,
                  menuAnchor.height,
                ),
                menu.getBoundingClientRect(),
                context.column,
                context.port,
                isUser,
              )
            : null;
        return () => {
          if (String(context.epoch) !== column.dataset.messageActionsEpoch) {
            entry.suspend();
            return;
          }
          positionActionPlane(node, context, slot, position);
          setTouch(context.touch);
          if (nextCompact !== compact) {
            entry.suspend();
            setCompact(nextCompact);
            onCompactChange(nextCompact);
            return;
          }
          settleActionPlane(node, context.epoch, available);
          settleActionMenu(menu, menuPosition, onMenuUnavailable);
          ownership.settle(messageAvailable, available);
          onSettled(node);
        };
      },
    };
    const enter = () => setHovered(true);
    const leave = (event: PointerEvent) => {
      if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) setHovered(false);
    };
    row.addEventListener('pointerenter', enter);
    row.addEventListener('pointerleave', leave);
    const unregister = registerActionPlane(column, entry);
    return () => {
      unregister();
      row.removeEventListener('pointerenter', enter);
      row.removeEventListener('pointerleave', leave);
    };
  }, [anchor, compact, host, isUser, onCompactChange, onMenuUnavailable, onSettled, owner, ownership]);
  useLayoutEffect(() => {
    void surfaceVersion;
    if (columnRef.current) refreshActionPlane(columnRef.current);
  }, [surfaceVersion]);

  const visible = hovered || focused || touch || expanded;
  return host
    ? createPortal(
        <div
          ref={plane}
          data-message-actions-owner={messageId}
          style={{
            position: 'fixed',
            width: 'max-content',
            // Message paint stays below the existing modal backdrop (20) and drawer (30).
            zIndex: 10,
            visibility: 'hidden',
            opacity: visible ? 1 : 0,
            pointerEvents: visible ? 'auto' : 'none',
          }}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !owner.current?.contains(event.relatedTarget))
              setHovered(false);
          }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
        >
          {children(compact)}
        </div>,
        host,
      )
    : null;
}
