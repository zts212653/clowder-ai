import type { CatData } from '@/hooks/useCatData';
import { preferenceHeads } from '../routing-context/routing-context-commands';
import type { RoutingContextQueryState } from '../routing-context/useRoutingContext';
import { HelpTip } from '../settings/HelpTip';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { routingSubjectName } from './member-projection';
import { useMemberClock } from './useMemberClock';

/** Display the current owner revisions; never infer a rule from its rationale. */
export function MemberPreferencesSummary({ routing, cats }: { routing: RoutingContextQueryState; cats: CatData[] }) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const now = useMemberClock(routing.data);
  const heads = preferenceHeads(routing.data?.preferenceRevisions ?? []).filter((p) => p.lifecycle === 'active');
  return (
    <div className="member-preferences">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong>{t('派活偏好')}</strong>
          <HelpTip topic={t('派活偏好')}>{copy.preferenceHelp}</HelpTip>
        </div>
        {routing.error || !routing.data ? (
          <p>{routing.loading ? t('正在读取…') : t('派活偏好暂不可读')}</p>
        ) : heads.length === 0 ? (
          <p>{t('没有设置派活偏好')}</p>
        ) : (
          <div role="group" aria-label={copy.currentRule}>
            {heads.map((p) => (
              <div key={p.revisionId} className="mt-2">
                <p>
                  {copy.preference(
                    p.prefer.map((s) => routingSubjectName(s, cats, copy.poolName)).join(' · '),
                    p.over.map((s) => routingSubjectName(s, cats, copy.poolName)).join(' · '),
                    p.appliesWhen.intent ?? '',
                  )}
                </p>
                {Boolean(p.appliesWhen.requireEligible?.length) && (
                  <p>
                    {copy.eligibility(
                      (p.appliesWhen.requireEligible ?? [])
                        .map((s) => routingSubjectName(s, cats, copy.poolName))
                        .join(' · '),
                    )}
                  </p>
                )}
                {p.reviewAfter !== undefined && p.reviewAfter <= now && <p role="status">{copy.reviewDue}</p>}
                <details className="text-xs text-cafe-muted">
                  <summary>{copy.preferenceReason}</summary>
                  <p>{p.rationale}</p>
                  <p>{copy.revision(p.version)}</p>
                  {p.evidenceRefs.map((ref) => (
                    <p key={ref}>{copy.evidence(ref)}</p>
                  ))}
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
      <OpenTeamWorkspaceButton label={t('打开猫猫团队')} />
    </div>
  );
}
