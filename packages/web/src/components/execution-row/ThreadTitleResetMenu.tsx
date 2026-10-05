'use client';

/**
 * F322 original-B: the thread title's ⌄ menu — where the NORMAL force-reset lives.
 *
 * The one-row surface floats 强制重置 only for three abnormal classes. "I just want to reset this conversation"
 * is a deliberate act and goes here, and only while something runs. It uses the same request and the same dialog as the
 * row (`useRowForceReset` / `postThreadForceReset`): the user is asked once, in the same words, and a refusal is never
 * reported as done. Mounted in the new-shell (v2) header only; the classic header does not render it.
 */
import { useEffect, useRef, useState } from 'react';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { ForceResetDialog } from '../ForceResetDialog';
import { useQueueActionConvergence } from '../useQueueActionConvergence';
import { useRowForceReset } from './useRowForceReset';

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
}

export function ThreadTitleResetMenu({ threadId }: { threadId: string }) {
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const running = Object.values(executionsByKey).some((execution) => execution.threadId === threadId);
  const convergence = useQueueActionConvergence(threadId, { resetDoneSurvivesRereadFailure: true });
  // No floating reasons and no stuck message here: this is the ordinary, thread-level reset.
  const reset = useRowForceReset({ threadId, reasons: [], stuckAction: null, convergence });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // The ⌄ goes away with the run; a question the user is already answering does not.
  const menuOpen = open && running;

  return (
    <>
      {running ? (
        <span ref={rootRef} className="relative inline-flex">
          <button
            type="button"
            data-testid="thread-title-menu-toggle"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="对话操作"
            title="对话操作"
            onClick={() => setOpen(!menuOpen)}
            className="shell-focusable flex h-6 w-6 items-center justify-center rounded-md text-cafe-muted transition-colors hover:text-cafe-secondary"
          >
            <ChevronDown />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              data-testid="thread-title-menu"
              className="absolute left-0 top-full z-20 mt-1 min-w-[9rem] rounded-lg border p-1 shadow-lg"
              style={{ background: 'var(--cafe-surface)', borderColor: 'var(--cafe-border, currentColor)' }}
            >
              <button
                type="button"
                role="menuitem"
                data-testid="thread-title-menu-force-reset"
                onClick={() => {
                  setOpen(false);
                  reset.request();
                }}
                className="shell-focusable w-full rounded-md px-3 py-1.5 text-left text-xs text-conn-red-text hover:bg-cafe-surface-sunken"
              >
                强制重置…
              </button>
            </div>
          ) : null}
        </span>
      ) : null}
      <ForceResetDialog {...reset.dialog} />
    </>
  );
}
