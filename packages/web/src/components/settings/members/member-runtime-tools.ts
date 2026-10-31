import type { AgentClientLibrary } from '@/hooks/useAgentClientLibraries';
import type { MemberText } from './MemberRuntimeFields';
import { MANUAL_RUNTIME_CHOICES } from './manual-runtime-choices';
import {
  matchesRuntime,
  type RuntimeChoice,
  type RuntimeDrafts,
  rememberedRuntimes,
  runtimeDefaults,
} from './member-runtime-draft';
import { nativeAcpProfileLabel } from './native-acp-profile-status';

export function memberRuntimeTools(
  runtimes: RuntimeChoice[],
  libraries: AgentClientLibrary[],
  runtimeDrafts?: RuntimeDrafts,
): RuntimeChoice[] {
  const pluginTools: RuntimeChoice[] = libraries.flatMap((library) =>
    library.clients.map((client) => ({
      id: client.ref,
      label: client.name,
      clientId: 'acp',
      installed: client.available,
      models: [],
      acp: { agentProvider: client.ref, command: 'plugin-agent', startupArgs: [] },
    })),
  );
  return [
    ...runtimes,
    ...pluginTools,
    ...rememberedRuntimes(runtimeDrafts).filter(
      (old) => ![...runtimes, ...pluginTools].some((item) => matchesRuntime(runtimeDefaults(old), item)),
    ),
    ...MANUAL_RUNTIME_CHOICES.filter(
      (item) => item.clientId === 'acp' || !runtimes.some((runtime) => runtime.clientId === item.clientId),
    ),
  ];
}

function runtimeStatus(item: RuntimeChoice, t: MemberText) {
  if (item.id.startsWith('plugin:'))
    return item.installed ? t('插件已启用', 'Plugin enabled') : t('插件未启用', 'Plugin disabled');
  if (item.id.startsWith('draft:')) return t('已保留的配置', 'Retained configuration');
  if (item.id.startsWith('manual:')) return t('手动配置', 'Manual configuration');
  return (
    nativeAcpProfileLabel(item.discoveryStatus, t) ??
    (item.installed ? t('已安装', 'Installed') : t('未找到', 'Not found'))
  );
}

export function memberRuntimeOptions(tools: RuntimeChoice[], t: MemberText) {
  return tools.map((item) => ({
    value: item.id,
    disabled: item.discoveryStatus === 'acp_profile_invalid' || (item.id.startsWith('plugin:') && !item.installed),
    label: `${item.agyCarrier === 'acp' ? t('AGY 官方 ACP', 'AGY official ACP') : item.label} · ${runtimeStatus(item, t)}`,
  }));
}
