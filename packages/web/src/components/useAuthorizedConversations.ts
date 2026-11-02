'use client';

import { useCallback, useEffect, useState } from 'react';
import { type AuthorizedConversationsRead, fetchAuthorizedConversations } from './authorized-conversations';
import { projectPersonalChromeRecoveryStatus } from './cloud-binding-recovery-status';

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
        ({ response, body, candidates }): AuthorizedConversationsRead =>
          response.ok
            ? { kind: 'ready', candidates, ...projectPersonalChromeRecoveryStatus(body) }
            : { kind: 'error', message: body.setupIssue?.message, actionLabel: body.setupIssue?.actionLabel },
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
