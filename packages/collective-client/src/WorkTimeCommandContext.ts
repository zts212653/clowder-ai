import { createContext } from 'react';
import type { WorkTimeChangeHandler } from './WorkTimeEditor.js';

export const WorkTimeCommandContext = createContext<{
  change?: WorkTimeChangeHandler;
  openSource?: (eventId: string, channelId: string) => void;
}>({});
