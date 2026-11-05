import { isDshLauncher } from '@cat-cafe/shared';
import { create } from 'zustand';
import type { MemberChoice } from '@/components/settings/members/MemberChoicePicker';
import type { MemberCatalog } from '@/components/settings/members/useRuntimeCatalog';
import type { CatData } from '@/hooks/useCatData';
import { dshModelLabel } from './dsh-model-label';

// Display metadata only. Names never replace stored ACP values or start extra probes.
export const useMemberModelCatalogs = create<{ catalogs: Record<string, MemberCatalog> }>(() => ({ catalogs: {} }));

export function memberModelCatalogKey(
  cat: Pick<CatData, 'id' | 'clientId' | 'acp' | 'agentProvider' | 'accountRef' | 'cliConfigArgs'>,
) {
  return JSON.stringify([
    cat.id,
    cat.clientId,
    cat.acp?.command,
    cat.acp?.startupArgs,
    (cat.agentProvider !== undefined ? cat.agentProvider : cat.acp?.agentProvider) || '',
    cat.accountRef || '',
    cat.cliConfigArgs ?? [],
  ]);
}

export function memberModelValueLabel(
  value: string,
  dsh: boolean,
  models: MemberChoice[] = [],
  english = false,
  reportedLabel?: string,
) {
  const option = models.find((item) => item.value === value);
  if (option && option.label !== value) {
    const duplicate = models.some((item) => item.value !== value && item.label === option.label);
    return duplicate ? `${option.label} · ${dsh ? dshModelLabel(value) : value}` : reportedLabel || option.label;
  }
  if (reportedLabel && reportedLabel !== value) return reportedLabel;
  const label = dsh ? dshModelLabel(value) : value;
  return label !== value ? `${label} · ${english ? 'Model ID' : '模型 ID'}` : value;
}

export function isDshMember(cat: Pick<CatData, 'clientId' | 'acp' | 'agentProvider'>) {
  const agentProvider = cat.agentProvider !== undefined ? cat.agentProvider : cat.acp?.agentProvider;
  return !agentProvider && cat.clientId === 'acp' && !!cat.acp && isDshLauncher(cat.acp.command, cat.acp.startupArgs);
}

export function useMemberModelLabel() {
  const catalogs = useMemberModelCatalogs((state) => state.catalogs);
  return (cat: CatData, follow: string, english = false) => {
    if (!isDshMember(cat)) return cat.defaultModel || follow;
    const catalog = catalogs[memberModelCatalogKey(cat)];
    const model = cat.defaultModel || catalog?.defaultModel;
    const label = model
      ? memberModelValueLabel(
          model,
          true,
          catalog?.models,
          english,
          !cat.defaultModel ? catalog?.defaultModelLabel : undefined,
        )
      : '';
    return cat.defaultModel ? label : label ? `${label} · ${follow}` : follow;
  };
}
