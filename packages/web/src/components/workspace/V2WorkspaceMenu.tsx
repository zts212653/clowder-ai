'use client';

import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AppTooltip } from '@/components/AppTooltip';
import { workspaceMenuPosition } from './workspace-menu-position';

export interface WorkspaceMenuContext {
  readonly open: boolean;
  readonly viewport: RefObject<HTMLDivElement>;
}

/** Native disclosure with one popup placement; content stays mounted when closed. */
export function V2WorkspaceMenu({
  trigger,
  triggerProps,
  width,
  tooltip,
  panelClassName = '',
  children,
  openRequest,
  focusSelector,
  scopeKey,
  onClose,
}: {
  trigger: ReactNode;
  triggerProps: ComponentPropsWithoutRef<'summary'> & { 'data-testid'?: string };
  width: number;
  tooltip?: string;
  panelClassName?: string;
  children: ReactNode | ((close: () => void, context: WorkspaceMenuContext) => ReactNode);
  /** An explicit once-only return intent, never a persistent open state. */
  openRequest?: number;
  focusSelector?: string;
  scopeKey?: string;
  onClose?: () => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [contextWidth, setContextWidth] = useState(width);
  const [position, setPosition] = useState<ReturnType<typeof workspaceMenuPosition>>();
  const handledRequest = useRef(0);
  const previousScope = useRef(scopeKey);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (details.current) details.current.open = false;
    setOpen(false);
    onCloseRef.current?.();
  }, []);
  useEffect(() => setPortal(document.body), []);
  useEffect(() => () => onCloseRef.current?.(), []);
  useEffect(() => {
    if (previousScope.current !== scopeKey) {
      previousScope.current = scopeKey;
      close();
    }
  }, [scopeKey, close]);
  useEffect(() => {
    if (
      !portal ||
      openRequest === undefined ||
      !Number.isSafeInteger(openRequest) ||
      openRequest <= handledRequest.current
    )
      return;
    handledRequest.current = openRequest;
    // A hidden/superseded trigger consumes no authority to reopen later.
    if (!details.current || !summary.current?.getClientRects().length) return;
    details.current.open = true;
    setOpen(true);
  }, [portal, openRequest]);
  useLayoutEffect(() => {
    const triggerNode = summary.current;
    const popup = panel.current;
    if (!portal || !open || !triggerNode || !popup) return;
    const boundary = triggerNode.closest<HTMLElement>('[data-v2-workspace-menu-boundary]') ?? details.current;
    if (!boundary) return;
    const measure = () => {
      if (!triggerNode.isConnected || triggerNode.getClientRects().length === 0) {
        close();
        return;
      }
      setContextWidth(boundary.clientWidth);
      const next = workspaceMenuPosition(
        triggerNode.getBoundingClientRect(),
        boundary.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        width,
        popup.scrollHeight + 2,
      );
      setPosition((previous) =>
        previous && Object.entries(next).every(([key, value]) => previous[key as keyof typeof previous] === value)
          ? previous
          : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(boundary);
    observer?.observe(popup);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, width, portal, close]);
  useEffect(() => {
    if (!open) return;
    const preferred = focusSelector ? panel.current?.querySelector<HTMLElement>(focusSelector) : null;
    if (preferred?.getClientRects().length) preferred.focus({ preventScroll: true });
    else {
      const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]');
      Array.from(focusable ?? [])
        .find((node) => node.getClientRects().length > 0)
        ?.focus();
    }
    const outside = (event: Event) => {
      if (!details.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      summary.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open, close, focusSelector]);
  const disclosure = (
    <details
      ref={details}
      className="relative shrink-0"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) onCloseRef.current?.();
      }}
    >
      <summary {...triggerProps} ref={summary} aria-controls={id}>
        {trigger}
      </summary>
      {portal &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              width: contextWidth,
              containerType: 'inline-size',
              pointerEvents: 'none',
              zIndex: 70,
            }}
          >
            <div
              id={id}
              ref={panel}
              hidden={!open}
              data-v2-workspace-menu=""
              style={{ ...position, pointerEvents: 'auto', display: open ? undefined : 'none' }}
              className={`fixed z-[70] overflow-auto overscroll-contain rounded-lg border border-cafe-subtle bg-cafe-surface p-1 text-cafe-black shadow-lg ${panelClassName}`}
            >
              {typeof children === 'function' ? children(close, { open, viewport: panel }) : children}
            </div>
          </div>,
          portal,
        )}
    </details>
  );
  return tooltip ? (
    <AppTooltip label={tooltip} side="bottom" disabled={open}>
      {disclosure}
    </AppTooltip>
  ) : (
    disclosure
  );
}
