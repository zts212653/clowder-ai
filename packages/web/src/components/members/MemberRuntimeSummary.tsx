import type { CatData } from '@/hooks/useCatData';
import { useIsDshMember, useMemberModelLabel } from '@/lib/member-model-display';
import { AppTooltip } from '../AppTooltip';
import { useMemberText } from './editor-presentation';
import { memberClientName } from './member-projection';

export function useMemberRuntimeLabel(cat: CatData) {
  const t = useMemberText();
  const modelLabel = useMemberModelLabel();
  const dshMember = useIsDshMember();
  return `${memberClientName(cat, dshMember(cat))} · ${modelLabel(cat, t(cat.configurationSource === 'native_tool' ? '跟随工具设置' : '未设置'), t('未设置') === 'Not set')}`;
}

export function MemberRuntimeSummary({ cat }: { cat: CatData }) {
  const label = useMemberRuntimeLabel(cat);
  return (
    <AppTooltip label={label} intent="content" multiline showOnClick>
      <button type="button" className="member-runtime-summary">
        {label}
      </button>
    </AppTooltip>
  );
}
