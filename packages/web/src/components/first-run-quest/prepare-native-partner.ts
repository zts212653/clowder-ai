import { serializeCommandArgs } from '../hub-cat-editor.acp';
import { type NativePartner, requiresDshDraftConfirmation } from './native-onboarding';
import { usesDetectedRuntimeConfiguration } from './native-partner-config';

/** Browsing is read-only. The user's create/save action confirms the detected route once. */
export async function prepareNativePartner(
  partner: NativePartner,
  headers: Record<string, string>,
  readJson: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<NativePartner> {
  if (requiresDshDraftConfirmation(partner))
    throw Error('已保留此前的 DSH 模型或思考强度设置，请在成员配置中确认连接后再创建。');
  if (
    !partner.runtime.dshSetupRequired ||
    partner.dshSetupPrepared ||
    !usesDetectedRuntimeConfiguration(partner.form, partner.runtime)
  )
    return partner;
  const route = partner.runtime.dshSetup;
  if (route?.status !== 'configured') throw Error('未找到可复用的 DSH 连接，请在成员配置中完成接入后重新检测。');
  const { sourceProfile, revision, provider, model } = route;
  const prepared = await readJson<{ command: string; startupArgs: string[] }>('/api/cats/dsh-setup/prepare', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      runtimeId: partner.runtime.dshSetupRuntimeId ?? partner.runtime.id,
      sourceProfile,
      revision,
      provider,
      model,
    }),
  }).catch((cause: unknown) => {
    if (cause instanceof Error && cause.message === 'dsh_setup_changed')
      throw Error('DSH 配置已变化，请重新检测后创建；原配置已保留。');
    throw cause;
  });
  return {
    ...partner,
    dshSetupPrepared: true,
    form: {
      ...partner.form,
      acpCommand: prepared.command,
      acpStartupArgs: serializeCommandArgs(prepared.startupArgs),
      defaultModel: '',
      cliEffort: '',
    },
  };
}
