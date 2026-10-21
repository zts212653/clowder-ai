import { HelpTip } from '../settings/HelpTip';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useShellCopy } from '../shell/shell-copy';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { memberStatusLabel, type MemberStatus as Status } from './member-projection';
import { memberSaveCopy } from './member-save.shell-copy';
export function MemberStatus({ status, catId }: { status: Status; catId?: string }) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const saveCopy = useShellCopy(memberSaveCopy);
  const detail = [
    ...new Set(
      [
        status.detailIsNote ? status.detail : t(status.detail),
        status.source && t(status.source),
        status.until !== undefined && copy.until(status.until),
        status.observedAt !== undefined && copy.observedTime(status.observedAt),
      ].filter(Boolean),
    ),
  ].join(' · ');
  const label = t(memberStatusLabel(status));
  return (
    <span className="member-status" data-tone={status.tone}>
      <HelpTip
        topic={label}
        triggerClassName="member-status-trigger"
        trigger={
          <span className="member-status-label">
            <i aria-hidden="true" />
            {label}
          </span>
        }
      >
        <p>{detail || saveCopy.noRecords}</p>
        {catId && <OpenTeamWorkspaceButton label={saveCopy.records} catId={catId} inline />}
      </HelpTip>
    </span>
  );
}
