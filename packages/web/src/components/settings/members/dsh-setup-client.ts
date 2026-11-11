import { apiFetch } from '@/utils/api-client';

export interface DshInspection {
  revision: string;
  provider?: string;
  model?: string;
  providers: {
    id: string;
    credential: 'configured' | 'missing' | 'native_auth';
    models: { id: string; label: string }[];
  }[];
}
export interface PreparedDshConnection {
  id: string;
  command: string;
  startupArgs: string[];
  env: Record<string, string>;
  provider: string;
  model: string;
}
// The automatic panel and save action may overlap; share only the unfinished read.
const pendingInspections = new Map<string, Promise<unknown>>();
export async function dshSetupRequest<T>(action: 'inspect' | 'prepare', body: Record<string, unknown>): Promise<T> {
  const key = action === 'inspect' ? JSON.stringify(body) : undefined;
  const reading = key ? pendingInspections.get(key) : undefined;
  if (reading) return reading as Promise<T>;
  const request = (async () => {
    const response = await apiFetch(`/api/cats/dsh-setup/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'dsh_setup_unavailable');
    return data as T;
  })();
  if (!key) return request;
  pendingInspections.set(key, request);
  return request.finally(() => pendingInspections.delete(key));
}
export function dshSetupError(reason: unknown) {
  const code = reason instanceof Error ? reason.message : '';
  const messages: Record<string, string> = {
    dsh_setup_changed: 'Desktop 配置已变化。请刷新配置后重新保存，当前草稿已保留。',
    dsh_setup_desktop_ambiguous: '发现多套 DSH Desktop。请在模型设置中选择安装位置后再保存。',
    dsh_setup_custom_startup: '未找到可用的 DSH Desktop。请完成安装后刷新，当前配置已保留。',
    dsh_setup_credential_missing: '所选路线尚未配置认证。请在 DSH Desktop 中完成登录或配置密钥后重试。',
    dsh_setup_credential_invalid: '无法读取 Desktop 认证文件。请在 DSH Desktop 中修复认证后重试。',
    dsh_setup_auth_refresh_required: 'Desktop 登录需要更新。请在 DSH Desktop 重新登录后重试。',
    dsh_setup_model_unavailable: '所选路线或模型已不可用。请刷新模型设置并重新选择；当前草稿已保留。',
    dsh_setup_busy: '正在读取其他 Desktop 配置。请稍后重试，当前草稿已保留。',
  };
  return messages[code] ?? '无法准备 Desktop 配置。请检查 DSH Desktop 的模型和认证设置后重试，当前配置已保留。';
}
