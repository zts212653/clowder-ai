import type { CatData } from '@/hooks/useCatData';
import type { HubCatEditorFormState } from './hub-cat-editor.model';

export function usesAgyNative(form: Pick<HubCatEditorFormState, 'clientId' | 'carrier' | 'agyNativeEnabled'>) {
  return form.clientId === 'google' && form.carrier !== 'acp' && form.agyNativeEnabled === true;
}

export function usesAgyAcp(form: Pick<HubCatEditorFormState, 'clientId' | 'carrier' | 'agyAcpEnabled'>) {
  return form.clientId === 'google' && form.carrier === 'acp' && form.agyAcpEnabled === true;
}

export function buildAgyProfilePatch(
  form: HubCatEditorFormState,
  cat?: CatData | null,
  accountAuthType?: 'oauth' | 'api_key' | null,
): Record<string, unknown> {
  const acp = usesAgyAcp(form);
  if (!usesAgyNative(form) && !acp)
    return cat?.agyProfile?.carrier === 'native' || cat?.agyProfile?.carrier === 'acp' ? { agyProfile: null } : {};
  if (accountAuthType === 'api_key') throw new Error('AGY Native 需要隔离 Profile 中已登录的个人 OAuth');
  const profileId = form.agyProfileId?.trim() || form.catId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(profileId)) throw new Error('隔离 Profile ID 格式无效');
  const model = form.defaultModel.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))
    throw new Error('AGY Native 模型需填写实际模型 ID，例如 gemini-3.8-flash-high');
  const trustedWorkspaces = Array.from(
    new Set(
      (form.agyTrustedWorkspaces ?? '')
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );
  if (!form.agyAutoApprove && !trustedWorkspaces.length) throw new Error('AGY Native 需要至少一个批准工作区');
  const homeRoot = form.agyHomeRoot?.trim();
  if (trustedWorkspaces.some((path) => !path.startsWith('/')) || (homeRoot && !homeRoot.startsWith('/'))) {
    throw new Error('Profile 根目录和批准工作区必须使用绝对路径');
  }
  return {
    agyProfile: {
      enabled: form.agyProfileEnabled ?? true,
      carrier: acp ? 'acp' : 'native',
      profileId,
      ...(homeRoot ? { homeRoot } : {}),
      model,
      autoApprove: form.agyAutoApprove === true,
      trustedWorkspaces,
    },
  };
}
