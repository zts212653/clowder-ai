type Text = (zh: string, en: string) => string;

export function nativeAcpProfileLabel(status: string | undefined, t: Text): string | undefined {
  if (status === 'acp_profile_missing')
    return t('已安装 · 首次连接初始化 ACP', 'Installed · ACP initializes on first connection');
  if (status === 'acp_profile_invalid') return t('已安装 · ACP 配置异常', 'Installed · Invalid ACP configuration');
  return undefined;
}

export function nativeAcpProfileMessage(status: string | undefined, t: Text): string | undefined {
  if (status === 'acp_profile_missing')
    return t(
      '浏览和创建伙伴不会初始化 ACP；实际连接时由 DSH 准备，之后可刷新尝试读取模型目录。',
      'Browsing and creating teammates does not initialize ACP. DSH prepares it on actual connection; refresh afterward to try reading models.',
    );
  if (status === 'acp_profile_invalid')
    return t(
      '请修复现有 ACP 配置后重新检测。猫咖不会自动覆盖已有配置；修复前无法通过此入口接入或读取模型目录。',
      'Repair the existing ACP configuration and refresh. Clowder will not overwrite it; this entry and model discovery remain unavailable until repaired.',
    );
  return undefined;
}
