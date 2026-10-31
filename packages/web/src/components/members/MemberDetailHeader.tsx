'use client';

import { useContext } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useConfirm } from '../useConfirm';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { MemberChanges } from './MemberChangeMark';
import { MemberCurrentStatus } from './MemberCurrentStatus';
import { MemberIdentity } from './MemberIdentity';
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
  return (
    <div>
      <MemberIdentity id={cat.id} />
      <div className="member-detail-status">
        <MemberCurrentStatus cat={cat} onBeforeOpen={beforeOpen} />
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
    </div>
  );
}
