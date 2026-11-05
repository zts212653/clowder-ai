'use client';

import { useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { SessionEventsViewer } from '../audit/SessionEventsViewer';
import type { RightStatusPanelProps } from '../RightStatusPanel';
import { SessionChainPanel, type SessionChainProjection, type SessionSummary } from '../SessionChainPanel';
import { useShellCopy } from '../shell/shell-copy';
import { collectSnapshotActiveCats, deriveActiveCats } from '../status-helpers';
import { StatusCatGroupV2 } from './StatusCatGroupV2';
import { StatusDetailsV2 } from './StatusDetailsV2';
import { statusPageCopy } from './status-page.shell-copy';
import { projectStatusLastRuns } from './status-run-history';
import './status-v2.css';

const EMPTY_MESSAGES: ChatMessage[] = [];

export function WorkspaceStatusPanelV2(props: RightStatusPanelProps) {
  // Transient actions, archive expansion and late receipts stay with their originating thread.
  return <StatusContents key={props.threadId} {...props} />;
}

function StatusContents(props: RightStatusPanelProps) {
  const t = useShellCopy(statusPageCopy);
  const messages = useChatStore((state) =>
    state.currentThreadId === props.threadId
      ? state.messages
      : (state.threadStates[props.threadId]?.messages ?? EMPTY_MESSAGES),
  );
  const lastRuns = useMemo(() => projectStatusLastRuns(messages), [messages]);
  const [viewing, setViewing] = useState<SessionSummary | null>(null);
  const [previousOpen, setPreviousOpen] = useState(false);
  const scrollRef = useRef<HTMLElement>(null);
  const returnScroll = useRef(0);
  const viewSession = (session: SessionSummary) => {
    returnScroll.current = scrollRef.current?.scrollTop ?? 0;
    setViewing(session);
  };
  const closeSession = () => {
    const sessionId = viewing?.id;
    setViewing(null);
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollTop = returnScroll.current;
      if (sessionId)
        scrollRef.current
          .querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(`view-session-${sessionId}`)}"]`)
          ?.focus({ preventScroll: true });
    });
  };
  const render = (owner: SessionChainProjection) => {
    const active = deriveActiveCats({
      targetCats: props.targetCats,
      activeInvocations: props.activeInvocations,
      hasActiveInvocation: props.hasActiveInvocation,
      intentMode: props.intentMode,
      snapshotCats: collectSnapshotActiveCats(props.catInvocations),
    });
    const currentIds = [
      ...new Set([
        ...props.targetCats,
        ...active,
        ...owner.sessions.filter((session) => session.status === 'active').map((session) => session.catId),
      ]),
    ];
    const previousIds = [
      ...new Set([
        ...owner.sessions.map((session) => session.catId),
        ...Object.keys(props.catInvocations),
        ...lastRuns.keys(),
      ]),
    ].filter((id) => !currentIds.includes(id));
    return (
      <aside
        ref={scrollRef}
        data-console-panel="status"
        data-file-origin-scroll
        data-testid="workspace-status-v2"
        className="status-v2"
        style={{ width: props.width ?? '100%' }}
      >
        {viewing && <SessionEventsViewer sessionId={viewing.id} catId={viewing.catId} onClose={closeSession} />}
        <div className="status-v2-layout" style={viewing ? { display: 'none' } : undefined}>
          <div className="status-v2-section status-v2-members">
            <h3>
              {t.members(currentIds.length)} <span>· {t.runningCount(owner.runningCatIds.size)}</span>
            </h3>
            {owner.loadError && (
              <div role="alert" className="status-v2-notice">
                <span className="status-v2-dot" style={{ background: 'var(--semantic-critical)' }} />
                {owner.loadError.message}
                <button type="button" onClick={owner.onRefresh}>
                  {t.retry}
                </button>
              </div>
            )}
            {owner.actionError && (
              <div role="alert" className="status-v2-notice">
                {owner.actionError}
                <button type="button" onClick={owner.onRefresh}>
                  {t.refresh}
                </button>
              </div>
            )}
            {owner.hasRecentCompact && (
              <p className="status-v2-notice">
                <span className="status-v2-dot" style={{ background: 'var(--semantic-warning)' }} />
                {t.safety}
              </p>
            )}
            {currentIds.map((catId) => (
              <StatusCatGroupV2
                key={catId}
                catId={catId}
                owner={owner}
                props={props}
                lastRun={lastRuns.get(catId)}
                onView={viewSession}
              />
            ))}
            {currentIds.length === 0 && (
              <p className="status-v2-muted">
                {owner.loading ? t.loading : owner.loadError ? t.membersUnavailable : t.noMembers}
              </p>
            )}
            {previousIds.length > 0 && (
              <div className="status-v2-previous">
                <button type="button" aria-expanded={previousOpen} onClick={() => setPreviousOpen((value) => !value)}>
                  {previousOpen ? '▾' : '›'} {t.previousMembers(previousIds.length)}
                </button>
                {previousOpen &&
                  previousIds.map((catId) => (
                    <StatusCatGroupV2
                      key={catId}
                      catId={catId}
                      owner={owner}
                      props={props}
                      lastRun={lastRuns.get(catId)}
                      onView={viewSession}
                    />
                  ))}
              </div>
            )}
          </div>
          <StatusDetailsV2 props={props} owner={owner} />
        </div>
      </aside>
    );
  };
  return (
    <SessionChainPanel
      threadId={props.threadId}
      catInvocations={props.catInvocations}
      activeInvocations={props.activeInvocations}
      refreshOnRunEnd
      renderProjection={render}
    />
  );
}
