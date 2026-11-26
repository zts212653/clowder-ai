'use client';
import { useEffect, useMemo, useState } from 'react';
import { projectReplyOutput } from '@/components/reply-layers/reply-output';
import { useProcessTalkPreference } from '@/hooks/useProcessTalkPreference';
import type { ChatMessage } from '@/stores/chat-types';

export function useReplyBindings(messages: ChatMessage[], threadId: string) {
  const preference = useProcessTalkPreference();
  const [verified, setVerified] = useState(new Map<string, string>());
  const bodies = useMemo(
    () => [...new Set(messages.filter((m) => m.extra?.outputLayout).map((m) => m.content))],
    [messages],
  );
  useEffect(() => {
    let active = true;
    const missing = bodies.filter((body) => !verified.has(body));
    if (missing.length)
      void Promise.all(
        missing.map(async (body) => {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
          return [
            body,
            Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
          ] as const;
        }),
      ).then((entries) => {
        if (active) setVerified((current) => new Map([...current, ...entries]));
      });
    return () => {
      active = false;
    };
  }, [bodies, verified]);
  const outputs = useMemo(
    () =>
      Object.fromEntries(
        messages.map((message) => [
          message.id,
          {
            content: message.content,
            projection: projectReplyOutput(message, threadId, verified.get(message.content), preference.mode),
          },
        ]),
      ),
    [messages, threadId, verified, preference.mode],
  );
  return {
    outputs,
    ready:
      bodies.every((body) => verified.has(body)) && preference.status !== 'idle' && preference.status !== 'loading',
    preference,
  };
}
