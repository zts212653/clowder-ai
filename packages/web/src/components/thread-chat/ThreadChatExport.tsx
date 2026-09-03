'use client';

import { useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useThreadLiveness, useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { ChatMessage } from '../ChatMessage';
import { loadExportThreadTitle, selectMessagesForExport } from '../message-export-selection';
import { collectExactLiveInvocationIds } from '../queue-receipt-projection';

export function ThreadChatExport({ threadId, messageIds }: { threadId: string; messageIds: string[] }) {
  const messages = useThreadMessages(threadId);
  const { isLoadingHistory } = useChatHistory(threadId);
  const { activeInvocations, catInvocations } = useThreadLiveness(threadId);
  const { getCatById, isLoading } = useCatData();
  const [threadTitle, setThreadTitle] = useState<string | null | undefined>(undefined);
  const cliDedupMap = useMemo(() => computeCliDiagnosticsDedup(messages), [messages]);
  const activeInvocationIds = useMemo(
    () => collectExactLiveInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );

  useEffect(() => {
    let active = true;
    setThreadTitle(undefined);
    loadExportThreadTitle(threadId)
      .then((title) => {
        if (active) setThreadTitle(title);
      })
      .catch(() => {
        if (active) setThreadTitle(null);
      });
    return () => {
      active = false;
    };
  }, [threadId]);

  const selection = selectMessagesForExport(messages, messageIds);
  const ready = !isLoadingHistory && !isLoading && selection.ready && threadTitle !== undefined;

  return (
    <div
      className="bg-[var(--console-shell-bg)]"
      data-export-root
      {...(ready ? { 'data-export-ready': 'true' } : {})}
      data-export-message-count={selection.messages.length}
    >
      <div className="mx-auto max-w-4xl p-4">
        <header className="mb-4 border-b border-cafe-divider pb-3">
          <h1 className="text-lg font-semibold text-cafe-primary">{threadTitle ?? '未命名对话'}</h1>
          <p className="mt-1 text-xs text-cafe-muted">来源 Thread: {threadId}</p>
        </header>
        {selection.messages.map((message) => {
          const dedupInfo = cliDedupMap.get(message.id);
          return (
            <ChatMessage
              key={message.id}
              message={message}
              threadId={threadId}
              activeInvocationIds={activeInvocationIds}
              getCatById={getCatById}
              hideDiagnosticsPanel={dedupInfo?.hideDiagnosticsPanel}
              dedupCount={dedupInfo?.dedupCount}
              forwardingDisabled
            />
          );
        })}
      </div>
    </div>
  );
}
