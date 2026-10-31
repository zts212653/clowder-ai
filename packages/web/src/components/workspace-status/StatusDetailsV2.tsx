'use client';

import { BindNewSessionSection } from '../BindNewSessionSection';
import { CloudConversationLink } from '../CloudConversationLink';
import { PlanBoardPanel } from '../PlanBoardPanel';
import {
  RevealWhispersButton,
  type RightStatusPanelProps,
  RuntimeLogsButton,
  ThinkingModeToggle,
} from '../RightStatusPanel';
import { SessionIdTag } from '../SessionChainInputs';
import type { SessionChainProjection } from '../SessionChainPanel';
import { useShellCopy } from '../shell/shell-copy';
import { ActivityRecordToggle } from './ActivityRecordToggle';
import { statusPageCopy } from './status-page.shell-copy';

export function StatusDetailsV2({ props, owner }: { props: RightStatusPanelProps; owner: SessionChainProjection }) {
  const t = useShellCopy(statusPageCopy);
  const { threadId, messageSummary } = props;
  return (
    <div className="status-v2-details">
      <section className="status-v2-section">
        <h3>{t.info}</h3>
        <dl>
          <div>
            <dt>{t.threadId}</dt>
            <dd>
              <SessionIdTag id={threadId} label={t.threadId} />
            </dd>
          </div>
          <div>
            <dt>{t.mode}</dt>
            <dd>{props.intentMode ? t.modes[props.intentMode] : t.modes.idle}</dd>
          </div>
          <div>
            <dt>{t.messages}</dt>
            <dd>
              {t.messageCounts(
                messageSummary.total,
                messageSummary.assistant,
                messageSummary.system,
                messageSummary.evidence,
                messageSummary.followup,
              )}
            </dd>
          </div>
        </dl>
        <RuntimeLogsButton threadId={threadId} compact />
        {threadId !== 'default' && owner.loadError?.kind !== 'access_denied' && (
          <>
            <CloudConversationLink threadId={threadId} compact />
            <BindNewSessionSection
              threadId={threadId}
              activeCatIds={
                new Set(owner.sessions.filter((session) => session.status === 'active').map((session) => session.catId))
              }
              disabled={owner.isStale}
              onBound={owner.onRefresh}
            />
          </>
        )}
      </section>
      <section className="status-v2-section status-v2-controls">
        <h3>
          {t.display} <span>{t.displayHint}</span>
        </h3>
        {/* 思考过程 is gone here: in the new shell the thinking is a row inside each reply's execution record. */}
        <ActivityRecordToggle threadId={threadId} />
      </section>
      <section className="status-v2-section status-v2-controls">
        <h3>
          {t.visibility} <span>{t.visibilityHint}</span>
        </h3>
        <ThinkingModeToggle threadId={threadId} v2 />
        <RevealWhispersButton threadId={threadId} v2 />
      </section>
      <PlanBoardPanel threadId={threadId} catInvocations={props.catInvocations} />
    </div>
  );
}
