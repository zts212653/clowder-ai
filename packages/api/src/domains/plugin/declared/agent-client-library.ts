import type {
  AgentClientLibraryDeclaration,
  AgentProviderDeclaration,
} from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import {
  parseAgentClientProfiles,
  parseAgentProviderConfiguration,
} from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';

/** Only a manifest-declared, non-secret owner configuration can supply launch profiles. */
export async function resolveAgentClientLibrary(input: {
  declaration: AgentClientLibraryDeclaration | AgentProviderDeclaration;
  admission: PluginRuntimeAdmission;
  packageRoot: string;
  configuration: Pick<PluginRuntimeConfigurationPort, 'readConfig'>;
}): Promise<AgentProviderDeclaration[]> {
  const { configurationKey } = input.declaration;
  if (!configurationKey) {
    if ('id' in input.declaration) {
      if (input.declaration.acp.permissionPolicy === 'auto_allow')
        throw new Error('ACP 权限自动允许需要 owner 显式保存选择，不能来自插件声明');
      return [input.declaration];
    }
    throw new Error('ACP 客户端缺少配置项声明');
  }
  const field = input.admission.packageRecord.manifest.configuration?.find((field) => field.key === configurationKey);
  if (!field || field.kind !== 'string') throw new Error('ACP 客户端目录必须引用声明的 string 配置项');
  const stored = await input.configuration.readConfig(input.admission.instance.pluginInstanceId, configurationKey);
  if ('id' in input.declaration) {
    const result = parseAgentProviderConfiguration(stored ?? field.default ?? '{}', input.declaration, {
      packageRoot: input.packageRoot,
    });
    if (!result.ok) throw new Error(`ACP 客户端配置无效，请在插件配置中修复：${result.reason}`);
    if (typeof stored !== 'string' && result.declaration.acp.permissionPolicy === 'auto_allow')
      throw new Error('ACP 权限自动允许需要 owner 显式保存选择，不能来自插件默认配置');
    return [
      {
        ...result.declaration,
        acp: { ...result.declaration.acp, permissionPolicy: result.declaration.acp.permissionPolicy ?? 'deny' },
      },
    ];
  }
  const result = parseAgentClientProfiles(stored ?? field.default ?? '[]', { packageRoot: input.packageRoot });
  if (!result.ok) throw new Error(`ACP 客户端配置无效，请在插件配置中修复：${result.reason}`);
  if (typeof stored !== 'string' && result.profiles.some((profile) => profile.acp.permissionPolicy === 'auto_allow'))
    throw new Error('ACP 权限自动允许需要 owner 显式保存选择，不能来自插件默认配置');
  return result.profiles;
}
