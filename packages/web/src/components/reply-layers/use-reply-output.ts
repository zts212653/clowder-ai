'use client';

import { useMemo } from 'react';
import { useProcessTalkPreference } from '@/hooks/useProcessTalkPreference';
import type { ChatMessage } from '@/stores/chat-types';
import { sha256Hex } from '@/utils/sha256-hex';
import { projectReplyOutput, replyLayoutAwaitsDigest } from './reply-output';

/**
 * A changed snapshot remains whole until its actual UTF-8 body hash is verified. The digest is
 * synchronous: an async one painted the whole body first and changed the row's height after mount.
 * It is computed only for a layout that every other condition already admits.
 */
export function useReplyOutput(message: ChatMessage, threadId: string | undefined, enabled: boolean) {
  const preference = useProcessTalkPreference(enabled);
  const content = message.content;
  const eligible = enabled && Boolean(threadId) && replyLayoutAwaitsDigest(message, threadId ?? '', preference.mode);
  const hash = useMemo(() => (eligible ? sha256Hex(content) : undefined), [content, eligible]);
  if (!eligible || !threadId || !hash) return undefined;
  return projectReplyOutput(message, threadId, hash, preference.mode);
}
