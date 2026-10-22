import type {
  AgentClientLibraryDeclaration,
  AgentProviderDeclaration,
} from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import { parseAgentClientProfiles } from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';

/** Only a manifest-declared, non-secret owner configuration can supply launch profiles. */
export async function resolveAgentClientLibrary(input: {
  declaration: AgentClientLibraryDeclaration;
  admission: PluginRuntimeAdmission;
  packageRoot: string;
  configuration: Pick<PluginRuntimeConfigurationPort, 'readConfig'>;
}): Promise<AgentProviderDeclaration[]> {
  const { configurationKey } = input.declaration;
  const field = input.admission.packageRecord.manifest.configuration?.find((field) => field.key === configurationKey);
  if (!field || field.kind !== 'string') throw new Error('ACP 客户端目录必须引用声明的 string 配置项');
  if (!input.admission.effectiveGrants.includes('plugin.config.read'))
    throw new Error('ACP 客户端目录缺少 plugin.config.read 授权');
  const stored = await input.configuration.readConfig(input.admission.instance.pluginInstanceId, configurationKey);
  const result = parseAgentClientProfiles(stored ?? field.default ?? '[]', { packageRoot: input.packageRoot });
  if (!result.ok) throw new Error(`ACP 客户端配置无效，请在插件配置中修复：${result.reason}`);
  return result.profiles;
}
