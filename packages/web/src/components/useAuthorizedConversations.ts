'use client';

import { useCallback, useEffect, useState } from 'react';
import { type AuthorizedConversationsRead, fetchAuthorizedConversations } from './authorized-conversations';

/** The conversations the extension may use, for the thread panel; `reread` asks the source again. */
export function useAuthorizedConversations(): { read: AuthorizedConversationsRead; reread: () => void } {
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ generation: number; read: AuthorizedConversationsRead }>({
    generation,
    read: { kind: 'loading' },
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthorizedConversations(controller.signal)
      .then(
        ({ response, candidates }): AuthorizedConversationsRead =>
          response.ok ? { kind: 'ready', candidates } : { kind: 'error' },
      )
      .catch((): AuthorizedConversationsRead => ({ kind: 'error' }))
      .then((read) => {
        if (!controller.signal.aborted) setState({ generation, read });
      });
    return () => controller.abort();
  }, [generation]);

  const reread = useCallback(() => setGeneration((current) => current + 1), []);
  return { read: state.generation === generation ? state.read : { kind: 'loading' }, reread };
}
