'use client';

import { useParams } from 'next/navigation';
import { ChatContainer } from '@/components/ChatContainer';

/**
 * Shared layout for "/" and "/thread/[threadId]".
 *
 * By placing ChatContainer here instead of in each page, it stays mounted
 * across thread switches — no unmount/remount flicker, no scroll-position
 * loss, and socket/state survives navigation.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ threadId?: string }>();
  const threadId = params?.threadId ?? 'default';

  return (
    <>
      <ChatContainer threadId={threadId} />
      {children}
    </>
  );
}
