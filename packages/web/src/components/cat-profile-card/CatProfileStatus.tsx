'use client';

import { useEffect, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { useExecutionRecoveryVerification } from '@/hooks/useExecutionRecoveryVerification';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { locateExecution } from '../execution-row/execution-location';
import { formatClock } from '../execution-row/row-model';
import { useMemberText } from '../members/editor-presentation';
import { memberStatus, memberStatusLabel } from '../members/member-projection';
import { useMemberClock } from '../members/useMemberClock';
import { useMemberLoginCheck } from '../members/useMemberLoginCheck';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { useShellCopy } from '../shell/shell-copy';
import { useMessageNavigation } from '../thread-chat/MessageNavigationContext';
import styles from './cat-profile-card.module.css';
import { catProfileCardCopy } from './cat-profile-card.shell-copy';

export function CatProfileStatus({ cat, threadId, onClose }: { cat: CatData; threadId: string; onClose(): void }) {
  const routing = useRoutingContext();
  const copy = useShellCopy(catProfileCardCopy);
  const t = useMemberText();
  const clock = useMemberClock(routing.data);
  const loginFor = useMemberLoginCheck(cat.configurationSource === 'native_tool');
  const executions = useActiveExecutionStore((state) => state.executionsByKey);
  const execution = Object.values(executions).find(
    (item) => item.threadId === threadId && item.catId === cat.id && item.kind === 'live_invocation',
  );
  const { canonicalProjectionStale, canonicalProjectionLoading, hasUnverifiedLegacyExecution } =
    useExecutionRecoveryVerification(threadId);
  const { activeInvocations } = useThreadLiveness(threadId);
  const unverifiedCatExecution =
    hasUnverifiedLegacyExecution && Object.values(activeInvocations).some((item) => item.catId === cat.id);
  const navigate = useMessageNavigation();
  const [now, setNow] = useState(Date.now);
  const startedAt = execution?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const status = memberStatus(cat, routing.data, routing.error, clock, loginFor(cat));
  if (unverifiedCatExecution || (execution && (canonicalProjectionStale || canonicalProjectionLoading))) {
    return (
      <div className={styles.status} data-tone="unknown">
        <i aria-hidden="true" />
        {copy.unconfirmed}
      </div>
    );
  }
  const elapsed = execution ? formatClock(now - execution.startedAt) : '';
  return (
    <div className={styles.status} data-tone={execution ? 'working' : status.tone}>
      <i aria-hidden="true" />
      {execution ? (
        <span>
          {copy.working(elapsed)}{' '}
          <button
            type="button"
            onClick={() => {
              if (locateExecution(execution, navigate) === 'unavailable') {
                useToastStore
                  .getState()
                  .addToast({ type: 'info', title: copy.record, message: copy.recordUnavailable, duration: 5000 });
                return;
              }
              onClose();
            }}
          >
            {copy.activity}
          </button>
        </span>
      ) : (
        <span>{routing.loading && !routing.data ? copy.loading : t(memberStatusLabel(status))}</span>
      )}
    </div>
  );
}
