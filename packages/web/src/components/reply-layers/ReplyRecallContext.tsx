'use client';

import { createContext, type ReactNode, useContext } from 'react';
import type { ReplyRecallProjection } from './reply-recall';

const EMPTY = new Map<string, ReplyRecallProjection>();
const ReplyRecallContext = createContext<ReadonlyMap<string, ReplyRecallProjection>>(EMPTY);

export function ReplyRecallProjectionProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, ReplyRecallProjection>;
  children: ReactNode;
}) {
  return <ReplyRecallContext.Provider value={value}>{children}</ReplyRecallContext.Provider>;
}

export function useReplyRecallProjection(messageId: string): ReplyRecallProjection | undefined {
  return useContext(ReplyRecallContext).get(messageId);
}
