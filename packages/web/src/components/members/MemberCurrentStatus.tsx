'use client';
import type { CatData } from '@/hooks/useCatData';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useShellCopy } from '../shell/shell-copy';
import { useMemberText } from './editor-presentation';
import { memberLatestWork, memberStatus, memberStatusLabel } from './member-projection';
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
  const work = memberLatestWork(cat.id, routing.data, now);
  const detail = work?.detail ?? (routing.data?.resolution.state === 'fresh' ? copy.noRecords : '');
  return (
    <div className="member-detail-summary" data-tone={status.tone}>
      <span className="member-status-label">
        <i aria-hidden="true" />
        {t(memberStatusLabel(status))}
      </span>
      {detail && <span> · {t(detail)}</span>}
      {work?.observedAt !== undefined && (
        <time dateTime={new Date(work.observedAt).toISOString()}> · {shortWorkTime(work.observedAt, now)}</time>
      )}
      <span> · </span>
      <OpenTeamWorkspaceButton label={copy.records} catId={cat.id} inline onBeforeOpen={onBeforeOpen} />
    </div>
  );
}

function shortWorkTime(observedAt: number, now: number) {
  const date = new Date(observedAt);
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.toDateString() === today.toDateString()
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
