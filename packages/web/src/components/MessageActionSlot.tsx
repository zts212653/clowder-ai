'use client';

import { createContext, type ReactNode, type RefCallback, useContext } from 'react';

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
  if (!register) return null;
  return (
    <div
      ref={register}
      data-message-action-slot
      className="relative h-0 w-0 shrink-0 self-center overflow-visible max-md:h-11 max-md:w-11 [@media(hover:none)_and_(pointer:coarse)]:h-11 [@media(hover:none)_and_(pointer:coarse)]:w-11"
    />
  );
}
