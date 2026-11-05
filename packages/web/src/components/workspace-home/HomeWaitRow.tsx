'use client';
import type { DeploymentWaitItemProjection } from '@cat-cafe/shared';
import { useId, useState } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ThreadChatLink } from '@/components/workspace/ThreadChatLink';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { formatWaitDuration, shortRevision } from './format';
import { type HomeCopy, homeCopy } from './workspace-home.shell-copy';

function conditionText(t: HomeCopy, item: DeploymentWaitItemProjection): string {
  const services = item.condition.services.map((service) => service.toUpperCase()).join(' + ');
  const ready = item.state === 'ready_to_return';
  if (item.condition.kind === 'revision_included') {
    const revision = shortRevision(item.condition.revision);
    return ready ? t.wait.satisfiedRevision(revision, services) : t.wait.awaitingRevision(revision, services);
  }
  return ready ? t.wait.satisfiedNewBoot(services) : t.wait.awaitingNewBoot(services);
}
function reasonText(t: HomeCopy, item: DeploymentWaitItemProjection): string | null {
  switch (item.stateReason) {
    case 'deployment_evidence_unavailable':
      return t.wait.reasonUnavailable;
    case 'deployment_evidence_incomplete':
      return t.wait.reasonIncomplete;
    case 'deployment_match_pending_recheck':
      return t.wait.reasonRecheck;
    default:
      return item.state === 'unknown' ? t.wait.undetermined : null;
  }
}
export function HomeWaitRow({ item, now }: { item: DeploymentWaitItemProjection; now: number }) {
  const t = useShellCopy(homeCopy);
  const { getCatById } = useCatData();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const owner = item.ownerCatId ? resolveCatNameplateName(item.ownerCatId, getCatById) : t.wait.ownerUnknown;
  const ready = item.state === 'ready_to_return';
  const reason = reasonText(t, item);
  const status = ready ? t.wait.readyShort : item.state === 'unknown' ? t.wait.unknownShort : t.wait.updateShort;
  const duration =
    item.createdAt === null
      ? t.wait.waitUnknown
      : formatWaitDuration(Math.max(0, (item.matchedAt ?? now) - item.createdAt), t.time);
  const nextStep = item.nextStep || t.wait.nextStepFallback;
  return (
    <article className="home-wait-row" data-testid="workspace-deployment-wait-item" data-state={item.state}>
      <div className="home-live-row home-wait-main">
        <ThreadChatLink
          threadId={item.threadId}
          className="home-live-main home-live-link shell-focusable"
          title={item.taskTitle}
        >
          <span className="home-live-heading">
            {item.ownerCatId && <CatAvatar catId={item.ownerCatId} size={20} ring="none" />}
            <span className="home-live-name text-compact">{owner}</span>
            <span className="home-live-status text-xs" data-tone="wait">
              <span className="home-execution-status-dot" aria-hidden="true" />
              {status}
            </span>
            <small className="home-live-clock text-xs">{duration}</small>
          </span>
          <b className="home-live-sub text-xs">{item.taskTitle}</b>
        </ThreadChatLink>
        <button
          type="button"
          className="home-trajectory shell-focusable"
          aria-label={ready ? t.wait.readyDetails : t.wait.returnDetails}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div id={id} className="home-wait-details text-xs" hidden={!expanded}>
        <small className="home-wait-line text-xs">{conditionText(t, item)}</small>
        {reason && <small className="home-wait-line text-xs">{reason}</small>}
        <small className="home-wait-line text-xs">
          {ready ? t.wait.canContinue(nextStep) : t.wait.afterReturn(nextStep)}
        </small>
      </div>
    </article>
  );
}
