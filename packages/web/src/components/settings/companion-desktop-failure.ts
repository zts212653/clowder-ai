import type { OfficialPluginInfo } from './official-plugin-types';

export const DESKTOP_FAILURE_COPY: Record<string, string> = {
  'renderer-gone': '桌面渲染进程结束',
  unresponsive: '桌面窗口无响应',
  'window-closed': '桌面窗口已关闭',
  'process-exit': '桌面进程退出',
  'request-timeout': '桌面与宿主通信超时',
  'protocol-violation': '桌面消息格式异常',
  'connection-ended': '桌面与宿主的连接断开',
  'heartbeat-expired': '桌面状态检查超时',
  'poll-failed': '桌面状态检查失败',
  'surface-unavailable': '桌面页面暂不可用',
};

/** A retained failure is different from a normally stopped runtime awaiting startup. */
export function retainedCompanionDesktopLoss(plugin: OfficialPluginInfo): boolean {
  const instance = plugin.instance;
  return (
    plugin.catalogId === 'companion' &&
    plugin.pluginId === 'official.companion' &&
    instance?.activationState === 'enabled' &&
    instance.runtimeState === 'stopped' &&
    instance.lastRuntimeError?.code === 'UNEXPECTED_RUNTIME_FAILURE' &&
    instance.lastRuntimeError.desktopReason !== undefined
  );
}
