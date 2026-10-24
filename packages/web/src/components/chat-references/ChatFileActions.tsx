'use client';
import type { ChatFileReference } from '@cat-cafe/shared';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { useActionOwnerReset, useActionSurfaceRef } from '../message-v2/message-action-ownership';
import { useShellCopy } from '../shell/shell-copy';
import styles from './chat-reference.module.css';
import { chatReferenceCopy } from './chat-reference.shell-copy';

/** Explicit human actions reuse the Workspace's registered-root desktop fence. */
export function ChatFileActions({
  target,
  visible = false,
  inline = false,
  hideTrigger = false,
  anchorRef,
  onInteract,
}: {
  target: ChatFileReference;
  visible?: boolean;
  inline?: boolean;
  hideTrigger?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onInteract?: (inside: boolean) => void;
}) {
  const t = useShellCopy(chatReferenceCopy);
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const ownedMenu = useActionSurfaceRef<HTMLSpanElement>(undefined, undefined, menu);
  useActionOwnerReset(() => setExpanded(false));
  const [position, setPosition] = useState({ left: 16, top: 16 });
  useEffect(() => setExpanded(visible), [visible]);
  useLayoutEffect(() => {
    if (!expanded || inline) return;
    function align() {
      const rect = (anchorRef?.current ?? anchor.current)?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(hideTrigger ? 480 : 256, window.innerWidth - 32);
      const height = menu.current?.getBoundingClientRect().height ?? 0;
      setPosition({
        left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)),
        top: Math.max(16, Math.min(rect.bottom + 4, window.innerHeight - height - 16)),
      });
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') setExpanded(false);
    }
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !menu.current?.contains(event.target) &&
        !anchorRef?.current?.contains(event.target)
      )
        setExpanded(false);
    }
    align();
    window.addEventListener('resize', align);
    window.addEventListener('scroll', align, true);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', align);
      window.removeEventListener('scroll', align, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [expanded, inline, anchorRef, hideTrigger]);
  async function action(kind: 'copy' | 'reveal' | 'open') {
    try {
      if (kind === 'copy') {
        await navigator.clipboard.writeText(target.absolutePath);
        setStatus(t.copied);
        return;
      }
      const response = await apiFetch(
        `/api/workspace/file/actions/${kind}?${new URLSearchParams({ worktreeId: target.worktreeId, path: target.path })}`,
        { method: 'POST' },
      );
      if (!response.ok) throw new Error();
      setStatus('');
    } catch {
      setStatus(t.failed);
    }
  }
  const actions =
    expanded || inline ? (
      <span
        ref={ownedMenu}
        onMouseEnter={() => onInteract?.(true)}
        onMouseLeave={() => onInteract?.(false)}
        onFocus={() => onInteract?.(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onInteract?.(false);
        }}
        style={
          inline ? undefined : { position: 'fixed', ...position, maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto' }
        }
        role="group"
        aria-label={t.more}
        className={
          inline
            ? 'flex flex-col items-stretch gap-1'
            : hideTrigger
              ? styles.fileTooltip
              : 'z-50 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-lg border border-[var(--shell-hairline)] bg-[var(--shell-paper)] p-3 text-[var(--shell-ink)] shadow-lg'
        }
      >
        {!inline ? <code className="whitespace-normal break-all text-xs">{target.absolutePath}</code> : null}
        <button
          type="button"
          onClick={() => void action('copy')}
          className="shell-focusable py-1 text-left hover:underline"
        >
          {t.copy}
        </button>
        <button
          type="button"
          onClick={() => void action('reveal')}
          className="shell-focusable py-1 text-left hover:underline"
        >
          {t.reveal}
        </button>
        {target.entryType === 'file' ? (
          <button
            type="button"
            onClick={() => void action('open')}
            className="shell-focusable py-1 text-left hover:underline"
          >
            {t.open}
          </button>
        ) : null}
        {status ? <span role="status">{status}</span> : null}
      </span>
    ) : null;
  return (
    <span ref={anchor} className="relative inline-block text-xs">
      {!inline && !hideTrigger ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          aria-label={t.more}
          className="shell-focusable cursor-pointer list-none rounded px-1 text-[var(--shell-muted)] hover:bg-[var(--shell-surface)]"
        >
          ⋯
        </button>
      ) : null}
      {inline ? actions : actions && typeof document !== 'undefined' ? createPortal(actions, document.body) : null}
    </span>
  );
}
