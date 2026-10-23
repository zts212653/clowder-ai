import type { AgentClientLibrary } from '@/hooks/useAgentClientLibraries';
import { usesAgyAcp, usesAgyNative } from '../../hub-cat-editor.agy';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
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

export type RuntimeEdition = 'intranet' | 'public';
const intranetHarnesses = ['codeagent', 'claudecode', 'codex', 'dsh', 'pi'];
const harnessLabels: Record<string, string> = {
  codeagent: 'CodeAgent',
  claudecode: 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
  pi: 'Pi',
};
export function memberRuntimeLabel(runtime: RuntimeChoice): string {
  return runtime.kind === 'binding' && runtime.sourceCatId
    ? (harnessLabels[runtime.harnessId ?? ''] ?? 'ACP')
    : runtime.label;
}
export function memberRuntimeName(form: HubCatEditorFormState, selected: RuntimeChoice | undefined, t: MemberText) {
  if (usesAgyAcp(form)) return t('AGY 官方 ACP', 'AGY official ACP');
  if (usesAgyNative(form)) return 'AGY Native';
  if (selected) return memberRuntimeLabel(selected);
  const labels: Record<string, string> = { openai: 'Codex', anthropic: 'Claude Code', acp: 'ACP' };
  return labels[form.clientId] ?? form.clientId;
}

function runtimeOptionStatus(item: RuntimeChoice, t: MemberText): string {
  if (item.id.startsWith('plugin:'))
    return t(item.installed ? '插件已启用' : '插件未启用', item.installed ? 'Plugin enabled' : 'Plugin disabled');
  if (item.id.startsWith('draft:')) return t('已保留的配置', 'Retained configuration');
  return (
    nativeAcpProfileLabel(item.discoveryStatus, t) ??
    (item.installed ? t('已安装', 'Installed') : t('未找到', 'Not found'))
  );
}

export function memberRuntimeTools(
  runtimes: RuntimeChoice[],
  libraries: AgentClientLibrary[],
  runtimeDrafts?: RuntimeDrafts,
  edition: RuntimeEdition = 'public',
): RuntimeChoice[] {
  const pluginTools: RuntimeChoice[] = libraries.flatMap((library) =>
    library.clients.map((client) => ({
      id: client.ref,
      label: client.name,
      kind: 'binding',
      clientId: 'acp',
      installed: client.available,
      models: [],
      acp: { agentProvider: client.ref, command: 'plugin-agent', startupArgs: [] },
    })),
  );
  return [
    ...runtimes.filter(
      (item) => edition !== 'intranet' || item.kind === 'binding' || intranetHarnesses.includes(item.harnessId ?? ''),
    ),
    ...pluginTools,
    ...rememberedRuntimes(runtimeDrafts).filter(
      (old) => ![...runtimes, ...pluginTools].some((item) => matchesRuntime(runtimeDefaults(old), item)),
    ),
    ...MANUAL_RUNTIME_CHOICES.filter(
      (item) =>
        (edition !== 'intranet' || item.clientId === 'acp') &&
        (item.clientId === 'acp' || !runtimes.some((runtime) => runtime.clientId === item.clientId)),
    ).map((item) => ({ ...item, kind: 'binding' as const })),
  ];
}

export function memberRuntimeOptions(tools: RuntimeChoice[], t: MemberText, scope?: 'tools' | 'bindings') {
  return tools
    .filter((item) => !scope || (scope === 'tools' ? item.kind === 'tool' : item.kind === 'binding'))
    .map((item) => ({
      value: item.id,
      disabled: item.discoveryStatus === 'acp_profile_invalid' || (item.id.startsWith('plugin:') && !item.installed),
      label: `${memberRuntimeLabel(item)}${item.kind === 'binding' && item.sourceCatId ? ` · ${t('已有配置', 'Saved configuration')} (${item.sourceCatId})` : ''} · ${runtimeOptionStatus(item, t)}`,
    }));
}
