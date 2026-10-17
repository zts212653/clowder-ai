import type { CatData } from '@/hooks/useCatData';
import { useMemberText } from './editor-presentation';
import { memberClientName } from './member-projection';

export function MemberRuntimeSummary({ cat }: { cat: CatData }) {
  const t = useMemberText();
  return (
    <span className="member-runtime-summary">
      {memberClientName(cat)} ·{' '}
      {cat.defaultModel || t(cat.configurationSource === 'native_tool' ? '跟随工具设置' : '未设置')}
    </span>
  );
}
