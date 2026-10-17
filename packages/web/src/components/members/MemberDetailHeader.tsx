'use client';

import { useContext } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useShellCopy } from '../shell/shell-copy';
import { useConfirm } from '../useConfirm';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { MemberChanges } from './MemberChangeMark';
import { type MemberStatus as MemberStatusReading, memberStatus } from './member-projection';
import { memberSaveCopy } from './member-save.shell-copy';
import { useMemberClock } from './useMemberClock';
import { useMemberLoginCheck } from './useMemberLoginCheck';
export function MemberDetailHeader({
  cat,
  toggling,
  onToggle,
}: {
  cat: CatData;
  toggling: boolean;
  onToggle: (cat: CatData) => void;
}) {
  const t = useMemberText();
  const routing = useRoutingContext();
  const now = useMemberClock(routing.data);
  const loginFor = useMemberLoginCheck(cat.configurationSource === 'native_tool');
  const copy = useShellCopy(memberSaveCopy);
  const changes = useContext(MemberChanges);
  const confirm = useConfirm();
  const editorCopy = useMembersCopy();
  const beforeOpen = async () =>
    changes.length === 0 ||
    (await confirm({
      title: editorCopy.closeTitle,
      message: editorCopy.unsavedPrompt,
      confirmLabel: editorCopy.leave,
      cancelLabel: editorCopy.取消,
    }));
  const status: MemberStatusReading =
    routing.loading && !routing.data
      ? { label: '读取中', detail: '', tone: 'unknown', observedAt: undefined, detailIsNote: false }
      : memberStatus(cat, routing.data, routing.error, now, loginFor(cat));
  const detail = status.detailIsNote ? status.source : status.detail;
  return (
    <div className="member-detail-status">
      <div className="member-detail-summary" data-tone={status.tone}>
        <span className="member-status-label">
          <i aria-hidden="true" />
          {t(status.label === '已恢复' ? '可用' : status.label)}
        </span>
        {detail && <span> · {t(detail)}</span>}
        {status.observedAt !== undefined && (
          <time dateTime={new Date(status.observedAt).toISOString()}>
            {' '}
            · {new Date(status.observedAt).toLocaleString()}
          </time>
        )}
        <span> · </span>
        <OpenTeamWorkspaceButton label={copy.records} catId={cat.id} inline onBeforeOpen={beforeOpen} />
      </div>
      <label className="member-enable-control">
        <span>{t('启用')}</span>
        <button
          type="button"
          className="member-switch"
          role="switch"
          aria-label={t('启用')}
          aria-checked={cat.roster?.available !== false}
          disabled={toggling}
          onClick={() => onToggle(cat)}
        >
          <span />
        </button>
      </label>
      <OpenTeamWorkspaceButton label={t('打开猫猫团队')} onBeforeOpen={beforeOpen} />
    </div>
  );
}
