'use client';
import { createContext, useContext } from 'react';

/** A message surface supplies its reading conversation; Settings/Workspace Markdown does not borrow global chat state. */
const Context = createContext<string | undefined>(undefined);
export const ChatReferenceScope = Context.Provider;
export function useChatReferenceThread() {
  return useContext(Context);
}
