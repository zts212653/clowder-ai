import { isDshLauncher } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import { type HubCatEditorFormState, initialState, splitCommandArgs } from '../../hub-cat-editor.model';
import { type DshInspection, dshSetupError, dshSetupRequest, type PreparedDshConnection } from './dsh-setup-client';
import { pickRuntime, type RuntimeChoice } from './member-runtime-draft';

export function needsDshPreparation(form: HubCatEditorFormState, baseline?: CatData | null) {
  return (
    form.configurationSource === 'native_tool' &&
    !form.accountRef &&
    form.carrier === 'acp' &&
    isDshLauncher(form.acpCommand, splitCommandArgs(form.acpStartupArgs)) &&
    (!baseline || JSON.stringify(pickRuntime(form)) !== JSON.stringify(pickRuntime(initialState(baseline))))
  );
}

/** Return the actual save intent; never depend on React state updates before a write. */
export async function prepareNativeMember(form: HubCatEditorFormState, baseline?: CatData | null) {
  if (!needsDshPreparation(form, baseline)) return form;
  return (async () => {
    const runtimeRevision = useMemberModelCatalogs.getState().runtimeRevision + 1;
    useMemberModelCatalogs.setState({ runtimeRevision });
    const response = await apiFetch('/api/cats/native-runtimes');
    if (!response.ok) throw Error('dsh_setup_custom_startup');
    const { runtimes } = (await response.json()) as { runtimes: RuntimeChoice[] };
    useMemberModelCatalogs.setState((state) =>
      state.runtimeConfirmedRevision <= runtimeRevision
        ? { runtimes, runtimeConfirmedRevision: runtimeRevision }
        : state,
    );
    const sources = runtimes.filter((runtime) => runtime.installed && runtime.dshDesktop && runtime.acp);
    const source =
      sources.find((runtime) => runtime.acp?.command === form.acpCommand) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!source) throw Error(sources.length > 1 ? 'dsh_setup_desktop_ambiguous' : 'dsh_setup_custom_startup');
    const inspection = await dshSetupRequest<DshInspection>('inspect', { runtimeId: source.id });
    const choices = inspection.providers.flatMap((provider) =>
      provider.credential === 'missing'
        ? []
        : provider.models.map((model) => ({ provider: provider.id, model: model.id })),
    );
    const explicit = choices.find((choice) => JSON.stringify([choice.provider, choice.model]) === form.defaultModel);
    // An explicit tuple must not silently become another provider/model.
    if (form.defaultModel.startsWith('[') && !explicit) throw Error('dsh_setup_model_unavailable');
    const selected =
      explicit ??
      choices.find((choice) => choice.provider === inspection.provider && choice.model === inspection.model);
    if (!selected) throw Error('dsh_setup_credential_missing');
    const prepared = await dshSetupRequest<PreparedDshConnection>('prepare', {
      runtimeId: source.id,
      revision: inspection.revision,
      ...selected,
    });
    return {
      ...form,
      acpCommand: prepared.command,
      acpStartupArgs: serializeCommandArgs(prepared.startupArgs),
      env: { ...form.env, ...prepared.env },
      defaultModel: JSON.stringify([prepared.provider, prepared.model]),
    };
  })().catch((error: unknown) => {
    throw Error(dshSetupError(error));
  });
}
