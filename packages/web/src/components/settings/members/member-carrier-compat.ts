import { getCatCarrierOptions } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';

type LegacyCarrierFields = {
  clientId: string;
  configurationSource?: HubCatEditorFormState['configurationSource'];
  carrier?: HubCatEditorFormState['carrier'];
  acpEnabled?: boolean;
  codexCarrier?: '' | 'exec_json' | 'app_server';
};

/** Both sides of a draft diff must use the same carrier coordinate system. */
export function normalizeMemberDraftBaseline(cat: CatData | null): CatData | null {
  if (!cat || cat.carrier) return cat;
  const legacyCli = cat.cli as (CatData['cli'] & { carrier?: LegacyCarrierFields['codexCarrier'] }) | undefined;
  return {
    ...cat,
    carrier: resolveDraftCarrier({
      clientId: cat.clientId,
      configurationSource: cat.configurationSource,
      acpEnabled: Boolean(cat.acp),
      codexCarrier: legacyCli?.carrier,
    }),
  };
}

/** Read-only compatibility for drafts saved before main introduced canonical carrier. */
export function resolveDraftCarrier(form: LegacyCarrierFields): HubCatEditorFormState['carrier'] {
  if (form.carrier) return form.carrier;
  if (form.acpEnabled || form.clientId === 'acp') return 'acp';
  if (form.clientId === 'openai') {
    if (form.codexCarrier) return form.codexCarrier === 'app_server' ? 'app_server' : 'cli';
    if (form.configurationSource === 'native_tool') return 'app_server';
  }
  return getCatCarrierOptions(form.clientId)[0] ?? 'cli';
}

export function normalizeMemberDraftForm(form: HubCatEditorFormState): HubCatEditorFormState {
  const canonical = { ...form };
  Reflect.deleteProperty(canonical, 'acpEnabled');
  Reflect.deleteProperty(canonical, 'codexCarrier');
  return { ...canonical, carrier: resolveDraftCarrier(form) };
}
