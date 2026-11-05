import type { CatData } from '@/hooks/useCatData';
import { AppTooltip } from '../AppTooltip';
import type { ProfileItem } from '../hub-accounts.types';
import { useMemberText } from './editor-presentation';
import { useMemberAccountLabel } from './MemberAccountName';
import { useMemberRuntimeLabel } from './MemberRuntimeSummary';
import { memberTransport } from './member-projection';

/** One continuous label lets narrow cards spend their width before truncating. */
export function MemberConnectionSummary({ cat, accounts }: { cat: CatData; accounts: ProfileItem[] }) {
  const t = useMemberText();
  const runtime = useMemberRuntimeLabel(cat);
  const account = useMemberAccountLabel({ cat, accounts });
  const label = `${runtime} · ${account} · ${t(memberTransport(cat))}`;
  return (
    <td className="member-connection-summary" colSpan={3}>
      <AppTooltip label={label} intent="content" multiline showOnClick>
        <button type="button" className="member-cell-text">
          {label}
        </button>
      </AppTooltip>
    </td>
  );
}
