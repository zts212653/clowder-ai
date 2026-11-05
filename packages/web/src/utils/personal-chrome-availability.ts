import { apiFetch } from './api-client';

export const PERSONAL_CHROME_PLUGIN_ID = 'official.companion.personal-chrome';
export interface PersonalChromeSetupIssue {
  message: string;
  actionLabel: string;
}

export const personalChromeInstallIssue: PersonalChromeSetupIssue = {
  message: '尚未安装 Personal Chrome，砚砚 Pro 还不能接收这里的消息。请安装并启用插件，再准备 Chrome 连接。',
  actionLabel: '安装 Personal Chrome',
};

/** Local inventory owns intent/live truth. A failed observation cannot erase readable authorizations. */
export async function readPersonalChromeSetupIssue(signal: AbortSignal): Promise<PersonalChromeSetupIssue | undefined> {
  try {
    const response = await apiFetch(`/api/plugin-manager/plugins/_local/${PERSONAL_CHROME_PLUGIN_ID}`, { signal });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return undefined;
    const plugin = (body as { plugin?: { pluginId?: unknown; artifact?: unknown; intent?: unknown; live?: unknown } })
      .plugin;
    if (plugin?.pluginId !== PERSONAL_CHROME_PLUGIN_ID || plugin.artifact !== 'installed') return undefined;
    if (plugin.intent === 'disabled')
      return {
        message: 'Personal Chrome 已安装但尚未启用，已有会话授权仍保留。请启用后再发送。',
        actionLabel: '启用 Personal Chrome',
      };
    if (plugin.intent === 'enabled' && typeof plugin.live === 'string' && plugin.live !== 'running')
      return {
        message: 'Personal Chrome 已启用，但连接组件尚未运行。请在插件设置中检查状态并恢复。',
        actionLabel: '检查 Personal Chrome',
      };
    return undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}
