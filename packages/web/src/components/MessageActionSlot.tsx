'use client';

import { createContext, type ReactNode, type RefCallback, useContext } from 'react';
import { useShellPresentation } from './shell/shell-presentation';

const MessageActionSlotContext = createContext<RefCallback<HTMLDivElement> | null>(null);

export function MessageActionSlotProvider({
  register,
  children,
}: {
  register: RefCallback<HTMLDivElement>;
  children: ReactNode;
}) {
  return <MessageActionSlotContext.Provider value={register}>{children}</MessageActionSlotContext.Provider>;
}

/** Stable horizontal owner for a message's transient action paint. */
export function MessageActionSlot() {
  const register = useContext(MessageActionSlotContext);
  const presentation = useShellPresentation();
  if (!register) return null;
  return (
    <div
      ref={register}
      data-message-action-slot
      className={
        presentation === 'v2'
          ? 'relative h-0 w-0 shrink-0 self-center overflow-visible'
          : 'relative h-0 w-0 shrink-0 self-center overflow-visible max-md:h-11 max-md:w-11 [@media(hover:none)_and_(pointer:coarse)]:h-11 [@media(hover:none)_and_(pointer:coarse)]:w-11'
      }
    />
  );
}

/** Static provenance and auxiliary facts have their own author line; the time-anchored dock cannot paint over them. */
export function MessageAuthorDetails({ children }: { children: ReactNode }) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? (
    <div data-message-author-details className="basis-full flex flex-wrap items-center gap-2 empty:hidden">
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}
