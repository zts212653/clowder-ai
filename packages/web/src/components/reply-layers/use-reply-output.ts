'use client';

import { useEffect, useState } from 'react';
import { useProcessTalkPreference } from '@/hooks/useProcessTalkPreference';
import type { ChatMessage } from '@/stores/chat-types';
import { projectReplyOutput } from './reply-output';

/** A changed snapshot remains whole until its actual UTF-8 body hash is verified. */
export function useReplyOutput(message: ChatMessage, threadId: string | undefined, enabled: boolean) {
  const preference = useProcessTalkPreference(enabled);
  const [verified, setVerified] = useState<{ content: string; hash: string }>();
  const content = message.content;
  const hasLayout = enabled && Boolean(threadId && message.extra?.outputLayout);
  useEffect(() => {
    if (!hasLayout || !globalThis.crypto?.subtle) return;
    let current = true;
    void globalThis.crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(content))
      .then((buffer) => {
        if (current)
          setVerified({
            content,
            hash: Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(''),
          });
      })
      .catch(() => {
        /* Unverifiable text retains the original whole-body presentation. */
      });
    return () => {
      current = false;
    };
  }, [content, hasLayout]);
  if (!hasLayout || !threadId || verified?.content !== content) return undefined;
  return projectReplyOutput(message, threadId, verified.hash, preference.mode);
}
