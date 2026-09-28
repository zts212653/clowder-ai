import type { OfficialPluginInfo } from './official-plugin-types';

interface Presentation {
  readonly name: string;
  readonly description: string;
  readonly detailLabel: string;
  readonly toggleLabel: string;
  readonly uninstallLabel: string;
  readonly icon: string;
  readonly avatarBackground: string;
}

const profiles: Readonly<Record<string, Pick<Presentation, 'name' | 'description' | 'icon' | 'avatarBackground'>>> = {
  'collective-connector': {
    name: 'Collective Connector',
    description: '把 Clowder AI endpoint 配对到独立 Collective Service；凭据只由 Host 托管',
    icon: 'collective',
    avatarBackground: 'var(--cafe-accent)',
  },
  'feishu-meeting-intake': {
    name: '飞书会议纪要同步',
    description: '自动接收飞书生成的智能纪要和文字稿，交给猫猫整理',
    icon: 'video',
    avatarBackground: 'var(--conn-feishu-bg)',
  },
  'genoffice-docx': {
    name: 'GenOffice',
    description: '在 Workspace 编辑 DOCX 文档，保存并继续协作版本 · alpha',
    icon: 'file-text',
    avatarBackground: 'var(--cafe-accent)',
  },
};

export function officialPluginPresentation(plugin: OfficialPluginInfo): Presentation {
  const profile = profiles[plugin.catalogId] ?? {
    name: plugin.packageName,
    description: '安装后手动启用已授权功能',
    icon: 'puzzle',
    avatarBackground: 'var(--cafe-accent)',
  };
  const separator = plugin.catalogId === 'feishu-meeting-intake' ? '' : ' ';
  return {
    ...profile,
    detailLabel: `查看${separator}${profile.name}${separator}详情`,
    toggleLabel: `${separator}${profile.name}`,
    uninstallLabel: `卸载${separator}${profile.name}`,
  };
}

export function officialPluginEnableConfirmation(plugin: OfficialPluginInfo): string {
  if (plugin.catalogId === 'genoffice-docx')
    return '确认启用 GenOffice？启用后可在 Workspace 打开和编辑 DOCX 文档。当前为 alpha。';
  if (plugin.catalogId === 'collective-connector')
    return '确认启用 Collective Connector？它会恢复 Host 托管的 endpoint 连接，但不会启动 Collective Service。';
  if (plugin.catalogId === 'feishu-meeting-intake') return '确认启用飞书会议纪要同步？启用后会连接本机 lark-cli。';
  return `确认启用 ${plugin.packageName} 的已授权功能？`;
}

export function officialPluginRepairGuidance(plugin: OfficialPluginInfo): string {
  if (plugin.catalogId === 'genoffice-docx') return '点“修复”恢复编辑器，再重新打开文档；已保存的协作版本会保留。';
  if (plugin.catalogId === 'collective-connector') return '检查 Connector 运行错误与本地凭据目录权限，再点“修复”。';
  if (plugin.catalogId === 'feishu-meeting-intake') return '请确认飞书账号授权有效，再点“修复”。';
  return '查看运行错误，排除原因后点“修复”。';
}
