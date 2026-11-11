'use client';

import type { AgentClientProfile as Profile } from '@/hooks/useAgentClientLibraries';

function decode(value: string, fixedClient?: Profile): Profile[] | null {
  try {
    const configured: unknown = JSON.parse(fixedClient ? value : value || '[]');
    if (
      fixedClient &&
      (!configured ||
        typeof configured !== 'object' ||
        Array.isArray(configured) ||
        Object.keys(configured).some(
          (key) => !['command', 'startupArgs', 'bootstrapRoot', 'mcpWhitelist', 'permissionPolicy'].includes(key),
        ))
    )
      return null;
    const profiles = fixedClient ? [{ ...fixedClient, ...(configured as Partial<Profile>) }] : configured;
    return Array.isArray(profiles) &&
      profiles.every(
        (profile) =>
          profile &&
          typeof profile.id === 'string' &&
          typeof profile.name === 'string' &&
          typeof profile.command === 'string' &&
          Array.isArray(profile.startupArgs) &&
          profile.startupArgs.every((arg: unknown) => typeof arg === 'string') &&
          (profile.permissionPolicy === undefined || ['deny', 'auto_allow'].includes(profile.permissionPolicy)),
      )
      ? profiles
      : null;
  } catch {
    return null;
  }
}
export function agentClientConfigurationError(value: string, fixedClient?: Profile): string | undefined {
  const profiles = decode(value, fixedClient);
  if (!profiles || profiles.length > 32)
    return fixedClient
      ? '客户端连接配置无效；仅支持启动字段覆盖，固定 ID 不能修改。'
      : '请配置最多 32 个有效的 ACP client。';
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile.id)) return '客户端 ID 需使用小写字母、数字、点、短横线或下划线。';
    if (ids.has(profile.id)) return `客户端 ID 重复：${profile.id}`;
    ids.add(profile.id);
    if (!profile.name.trim() || !profile.command.trim()) return '请填写每个客户端的名称和启动命令。';
    if (
      profile.bootstrapRoot !== undefined &&
      (typeof profile.bootstrapRoot !== 'string' ||
        !/^(?:[a-z]:[\\/]|\/)/i.test(profile.bootstrapRoot) ||
        /[\u0000\r\n]/.test(profile.bootstrapRoot))
    )
      return '引导目录须为运行 Host 的电脑上的绝对路径，或清空后自动选择。';
  }
  return undefined;
}
