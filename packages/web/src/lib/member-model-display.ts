import { isDshLauncher } from '@cat-cafe/shared';
import { create } from 'zustand';
import type { MemberChoice } from '@/components/settings/members/MemberChoicePicker';
import type { MemberCatalog } from '@/components/settings/members/useRuntimeCatalog';
import type { CatData } from '@/hooks/useCatData';
import { dshModelLabel } from './dsh-model-label';

// Display metadata only. Names never replace stored ACP values or start extra probes.
export const useMemberModelCatalogs = create<{ catalogs: Record<string, MemberCatalog> }>(() => ({ catalogs: {} }));

export function memberModelCatalogKey(cat: Pick<CatData, 'id' | 'clientId' | 'acp' | 'accountRef' | 'cliConfigArgs'>) {
  return JSON.stringify([
    cat.id,
    cat.clientId,
    cat.acp?.command,
    cat.acp?.startupArgs,
    cat.accountRef || '',
    cat.cliConfigArgs ?? [],
  ]);
}

export function memberModelValueLabel(value: string, dsh: boolean, models: MemberChoice[] = [], english = false) {
  const option = models.find((item) => item.value === value);
  if (option && option.label !== value) {
    const duplicate = models.some((item) => item.value !== value && item.label === option.label);
    return duplicate ? `${option.label} · ${option.group || (dsh ? dshModelLabel(value) : value)}` : option.label;
  }
  const label = dsh ? dshModelLabel(value) : value;
  return label !== value ? `${label} · ${english ? 'Model ID' : '模型 ID'}` : value;
}

export function isDshMember(cat: Pick<CatData, 'clientId' | 'acp'>) {
  return cat.clientId === 'acp' && !!cat.acp && isDshLauncher(cat.acp.command, cat.acp.startupArgs);
}

export function useMemberModelLabel() {
  const catalogs = useMemberModelCatalogs((state) => state.catalogs);
  return (cat: CatData, follow: string, english = false) => {
    if (!isDshMember(cat)) return cat.defaultModel || follow;
    const catalog = catalogs[memberModelCatalogKey(cat)];
    const model = cat.defaultModel || catalog?.defaultModel;
    const label = model
      ? !cat.defaultModel && catalog?.defaultModelLabel && catalog.defaultModelLabel !== model
        ? catalog.defaultModelLabel
        : memberModelValueLabel(model, true, catalog?.models, english)
      : '';
    return cat.defaultModel ? label : label ? `${label} · ${follow}` : follow;
  };
}
