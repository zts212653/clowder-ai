import { useEffect, useRef, useState } from 'react';
import { useGovernanceStatus } from '@/hooks/useGovernanceStatus';
import { useIndexState } from '@/hooks/useIndexState';
import { useChatStore } from '@/stores/chatStore';

export function useProjectBootstrapState(threadId: string, messageCount: number) {
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const { status: govStatus, refetch: govRefetch } = useGovernanceStatus(currentProjectPath);
  const [setupDone, setSetupDone] = useState(false);
  const showSetupCard = !!(
    (govStatus?.needsBootstrap || govStatus?.needsConfirmation || setupDone) &&
    messageCount === 0
  );
  const prevThreadSetup = useRef(threadId);

  useEffect(() => {
    if (prevThreadSetup.current !== threadId) {
      prevThreadSetup.current = threadId;
      setSetupDone(false);
    }
  }, [threadId]);

  const {
    state: indexState,
    progress: bootstrapProgress,
    summary: bootstrapSummary,
    durationMs: bootstrapDurationMs,
    isSnoozed,
    startBootstrap,
    snooze: snoozeBootstrap,
    handleSocketEvent: handleIndexSocketEvent,
  } = useIndexState(currentProjectPath);

  return {
    currentProjectPath,
    govStatus,
    govRefetch,
    setupDone,
    setSetupDone,
    showSetupCard,
    indexState,
    bootstrapProgress,
    bootstrapSummary,
    bootstrapDurationMs,
    isSnoozed,
    startBootstrap,
    snoozeBootstrap,
    handleIndexSocketEvent,
  };
}
