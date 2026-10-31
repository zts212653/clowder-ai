'use client';

import { createContext, useContext } from 'react';
import type { MessagePartSelection } from './message-part-selection';

export interface RichBlockSelectionContextValue {
  messageId: string;
  selection?: MessagePartSelection;
  disabled: boolean;
  onToggle?: (messageId: string, blockId: string) => void;
}

export const RichBlockSelectionContext = createContext<RichBlockSelectionContextValue | null>(null);
export const useRichBlockSelection = () => useContext(RichBlockSelectionContext);
