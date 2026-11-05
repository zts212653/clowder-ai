import { isDshLauncher } from '@cat-cafe/shared';
import { create } from 'zustand';
import type { MemberChoice } from '@/components/settings/members/MemberChoicePicker';
import type { RuntimeChoice } from '@/components/settings/members/member-runtime-draft';
import type { MemberCatalog } from '@/components/settings/members/useRuntimeCatalog';
import type { CatData } from '@/hooks/useCatData';
import { dshModelLabel } from './dsh-model-label';

// Display metadata only. Names never replace stored ACP values or start extra probes.
export const useMemberModelCatalogs = create<{
  catalogs: Record<string, MemberCatalog>;
  runtimes: readonly RuntimeChoice[];
}>(() => ({ catalogs: {}, runtimes: [] }));

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

export function isDshMember(
  cat: Pick<CatData, 'clientId' | 'acp' | 'agentProvider'>,
  runtimes: readonly RuntimeChoice[] = [],
) {
  const agentProvider = cat.agentProvider !== undefined ? cat.agentProvider : cat.acp?.agentProvider;
  if (agentProvider || cat.clientId !== 'acp' || !cat.acp) return false;
  const acp = cat.acp;
  if (isDshLauncher(acp.command, acp.startupArgs)) return true;
  // Both profile discovery and setup support are backend-verified, including supported --patch launches.
  return runtimes.some(
    (runtime) =>
      runtime.clientId === 'acp' &&
      (runtime.id === 'dsh' ||
        (runtime.id.startsWith('acp:') &&
          (runtime.discoveryStatus !== undefined || runtime.dshSetupSupported === true))) &&
      runtime.acp &&
      !runtime.acp.agentProvider &&
      runtime.acp.command === acp.command &&
      JSON.stringify(runtime.acp.startupArgs) === JSON.stringify(acp.startupArgs),
  );
}

export function useIsDshMember() {
  const runtimes = useMemberModelCatalogs((state) => state.runtimes);
  return (cat: Pick<CatData, 'clientId' | 'acp' | 'agentProvider'>) => isDshMember(cat, runtimes);
}

export function useMemberModelLabel() {
  const catalogs = useMemberModelCatalogs((state) => state.catalogs);
  const dshMember = useIsDshMember();
  return (cat: CatData, follow: string, english = false) => {
    if (!dshMember(cat)) return cat.defaultModel || follow;
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
