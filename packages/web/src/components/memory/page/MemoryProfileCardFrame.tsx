import type { ReactNode } from 'react';

/** The title button is the keyboard entry; the card also accepts ordinary pointer clicks. */
export function MemoryProfileCardFrame({
  selected,
  select,
  children,
}: {
  selected: boolean;
  select: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the native title button provides the same action for keyboard users.
    <article
      className={`min-w-0 cursor-pointer rounded-xl border bg-[var(--console-card-bg)] p-3 transition-colors hover:border-cafe-accent focus-within:border-cafe-accent ${selected ? 'border-cafe-accent' : 'border-cafe-subtle'}`}
      onClick={(event) => {
        if (event.defaultPrevented) return;
        // A nested action owns its click; it must not select the card again as it bubbles.
        if (
          event.target instanceof Element &&
          event.target.closest(
            'button, a, input, select, textarea, summary, [role="button"], [role="link"], [contenteditable="true"]',
          )
        )
          return;
        const selection = window.getSelection();
        if (
          selection &&
          !selection.isCollapsed &&
          selection.rangeCount > 0 &&
          selection.getRangeAt(0).intersectsNode(event.currentTarget)
        )
          return;
        select();
      }}
    >
      {children}
    </article>
  );
}
