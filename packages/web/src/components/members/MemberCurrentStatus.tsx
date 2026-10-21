'use client';
import type { CatData } from '@/hooks/useCatData';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useShellCopy } from '../shell/shell-copy';
import { useMemberText } from './editor-presentation';
import { memberStatus, memberStatusLabel } from './member-projection';
import { memberSaveCopy } from './member-save.shell-copy';
import { useMemberClock } from './useMemberClock';
import { useMemberLoginCheck } from './useMemberLoginCheck';

export function MemberCurrentStatus({ cat, onBeforeOpen }: { cat: CatData; onBeforeOpen?: () => Promise<boolean> }) {
  const t = useMemberText();
  const copy = useShellCopy(memberSaveCopy);
  const routing = useRoutingContext();
  const now = useMemberClock(routing.data);
  const loginFor = useMemberLoginCheck(cat.configurationSource === 'native_tool');
  const status =
    routing.loading && !routing.data
      ? {
          label: '读取中',
          detail: '',
          tone: 'unknown' as const,
          observedAt: undefined,
          detailIsNote: false,
          source: undefined,
        }
      : memberStatus(cat, routing.data, routing.error, now, loginFor(cat));
  const detail = status.detailIsNote ? status.source : status.detail;
  return (
    <div className="member-detail-summary" data-tone={status.tone}>
      <span className="member-status-label">
        <i aria-hidden="true" />
        {t(memberStatusLabel(status))}
      </span>
      {detail && <span> · {t(detail)}</span>}
      {status.observedAt !== undefined && (
        <time dateTime={new Date(status.observedAt).toISOString()}>
          {' '}
          · {new Date(status.observedAt).toLocaleString()}
        </time>
      )}
      <span> · </span>
      <OpenTeamWorkspaceButton label={copy.records} catId={cat.id} inline onBeforeOpen={onBeforeOpen} />
    </div>
  );
}
