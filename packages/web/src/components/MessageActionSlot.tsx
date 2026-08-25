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
  return <div ref={register} data-message-action-slot className="flex shrink-0 items-center" />;
}
