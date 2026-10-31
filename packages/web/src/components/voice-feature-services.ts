'use client';

import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

export type VoiceFeature = 'voice-companion' | 'audio-capture';

export interface ServicePrerequisites {
  estimatedMinutes?: number;
}

export type ServiceStatus =
  | 'healthy'
  | 'unhealthy'
  | 'not_configured'
  | 'installing'
  | 'starting'
  | 'stopping'
  | 'uninstalling';

export interface ServiceState {
  id: string;
  installed: boolean;
  enabled: boolean;
  installable: boolean;
  status?: ServiceStatus;
  error?: string | null;
  prerequisites?: ServicePrerequisites;
}

export type VoiceServiceReadyResult =
  | { ready: true }
  | { ready: false; installRequired?: { feature: VoiceFeature; service: ServiceState } };

/**
 * The user-visible words of the toasts this module raises. Callers from the v2 shell pass a localized set built from
 * the surface dictionary; the default is the exact Chinese wording the classic Workspace cards have always shown,
 * so classic callers (no `ui`) are byte-for-byte unchanged and never subscribe to the v2 language preference.
 */
export interface VoiceServiceUi {
  serviceName: string;
  notInstalledTitle: (service: string) => string;
  notInstalledMessage: (service: string) => string;
  enableFailedTitle: (service: string) => string;
  installFailedTitle: (service: string) => string;
  cannotReadStatus: (service: string) => string;
  startupFailedLogs: (service: string) => string;
  startupTimeout: (service: string) => string;
  notStartedYet: (service: string) => string;
  cannotConnectManager: (service: string) => string;
  cannotEnable: (service: string) => string;
  cannotInstall: (service: string) => string;
}

const CLASSIC_UI: Record<VoiceFeature, VoiceServiceUi> = {
  'voice-companion': {
    serviceName: '语音合成',
    notInstalledTitle: (s) => `${s}未安装`,
    notInstalledMessage: (s) => `请到设置 → 语音管理安装并启用${s}服务。`,
    enableFailedTitle: (s) => `${s}启用失败`,
    installFailedTitle: (s) => `${s}安装失败`,
    cannotReadStatus: (s) => `无法读取${s}服务状态。`,
    startupFailedLogs: (s) => `${s}启动失败，请查看服务日志。`,
    startupTimeout: (s) => `${s}启动超时，请查看服务日志。`,
    notStartedYet: (s) => `${s}尚未启动完成。`,
    cannotConnectManager: (s) => `无法连接${s}服务管理接口。`,
    cannotEnable: (s) => `无法启用${s}服务。`,
    cannotInstall: (s) => `无法安装${s}服务。`,
  },
  'audio-capture': {
    serviceName: '音频采集',
    notInstalledTitle: (s) => `${s}未安装`,
    notInstalledMessage: (s) => `请到设置 → 语音管理安装并启用${s}服务。`,
    enableFailedTitle: (s) => `${s}启用失败`,
    installFailedTitle: (s) => `${s}安装失败`,
    cannotReadStatus: (s) => `无法读取${s}服务状态。`,
    startupFailedLogs: (s) => `${s}启动失败，请查看服务日志。`,
    startupTimeout: (s) => `${s}启动超时，请查看服务日志。`,
    notStartedYet: (s) => `${s}尚未启动完成。`,
    cannotConnectManager: (s) => `无法连接${s}服务管理接口。`,
    cannotEnable: (s) => `无法启用${s}服务。`,
    cannotInstall: (s) => `无法安装${s}服务。`,
  },
};

export const FEATURE_SERVICES: Record<VoiceFeature, { serviceId: string; serviceLabel: string }> = {
  'voice-companion': { serviceId: 'mlx-tts', serviceLabel: '语音合成' },
  'audio-capture': { serviceId: 'audio-capture', serviceLabel: '音频采集' },
};

function uiFor(feature: VoiceFeature, ui?: VoiceServiceUi): VoiceServiceUi {
  return ui ?? CLASSIC_UI[feature];
}

const SERVICE_READY_TIMEOUT_MS = 10 * 60 * 1000;
const SERVICE_READY_RETRY_MS = 1_000;

function toastServiceMissing(feature: VoiceFeature, ui: VoiceServiceUi) {
  const { serviceName } = ui;
  useToastStore.getState().addToast({
    type: 'info',
    title: ui.notInstalledTitle(serviceName),
    message: ui.notInstalledMessage(serviceName),
    duration: 6000,
  });
}

function toastServiceError(ui: VoiceServiceUi, message: string) {
  useToastStore.getState().addToast({
    type: 'error',
    title: ui.enableFailedTitle(ui.serviceName),
    message,
    duration: 6000,
  });
}

function toastServiceInstallError(ui: VoiceServiceUi, message: string) {
  useToastStore.getState().addToast({
    type: 'error',
    title: ui.installFailedTitle(ui.serviceName),
    message,
    duration: 6000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readVoiceService(feature: VoiceFeature): Promise<ServiceState | null> {
  const { serviceId } = FEATURE_SERVICES[feature];
  const servicesRes = await apiFetch('/api/services');
  if (!servicesRes.ok) return null;
  const servicesPayload = (await servicesRes.json().catch(() => ({}))) as { services?: ServiceState[] };
  return servicesPayload.services?.find((item) => item.id === serviceId) ?? null;
}

export async function readServiceLogDetails(serviceId: string): Promise<string | null> {
  const res = await apiFetch(`/api/services/${serviceId}/logs`).catch(() => null);
  if (!res?.ok) return null;
  const payload = (await res.json().catch(() => ({}))) as { lines?: string[] };
  const lines = payload.lines?.filter((line) => line.trim().length > 0);
  if (!lines?.length) return null;
  return lines.join('\n');
}

export function isServiceReady(service: ServiceState): boolean {
  return service.status === 'healthy' || (service.enabled && service.status === undefined);
}

export function isServiceStarting(service: ServiceState): boolean {
  return service.status === 'starting' || service.status === 'installing';
}

async function toastServiceStartupFailure(
  feature: VoiceFeature,
  service: ServiceState | null,
  ui: VoiceServiceUi,
  fallback?: string,
) {
  const { serviceId } = FEATURE_SERVICES[feature];
  const logDetails = await readServiceLogDetails(serviceId);
  const rawError = service?.error?.trim();
  const headline =
    rawError && rawError !== 'fetch failed' ? rawError : (fallback ?? ui.startupFailedLogs(ui.serviceName));
  toastServiceError(ui, logDetails ? `${headline}\n${logDetails}` : headline);
}

async function waitForVoiceServiceReady(feature: VoiceFeature, ui: VoiceServiceUi): Promise<VoiceServiceReadyResult> {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  let firstProbe = true;

  while (Date.now() < deadline) {
    if (!firstProbe) await sleep(SERVICE_READY_RETRY_MS);
    firstProbe = false;

    const service = await readVoiceService(feature);
    if (!service) {
      toastServiceError(ui, ui.cannotReadStatus(ui.serviceName));
      return { ready: false };
    }
    if (isServiceReady(service)) return { ready: true };
    if (service.status === 'unhealthy') {
      await toastServiceStartupFailure(feature, service, ui);
      return { ready: false };
    }
    if (!isServiceStarting(service)) {
      toastServiceError(ui, ui.notStartedYet(ui.serviceName));
      return { ready: false };
    }
  }

  await toastServiceStartupFailure(feature, null, ui, ui.startupTimeout(ui.serviceName));
  return { ready: false };
}

export async function ensureVoiceServiceEnabled(
  feature: VoiceFeature,
  ui?: VoiceServiceUi,
): Promise<VoiceServiceReadyResult> {
  const words = uiFor(feature, ui);
  const { serviceId } = FEATURE_SERVICES[feature];
  try {
    const service = await readVoiceService(feature);
    if (!service) {
      toastServiceError(words, words.cannotReadStatus(words.serviceName));
      return { ready: false };
    }
    if (!service?.installed) {
      if (service?.installable && service.prerequisites) {
        return { ready: false, installRequired: { feature, service } };
      }
      toastServiceMissing(feature, words);
      return { ready: false };
    }
    if (service.enabled) {
      if (isServiceReady(service)) return { ready: true };
      if (isServiceStarting(service)) return waitForVoiceServiceReady(feature, words);
      if (service.status === 'unhealthy') {
        await toastServiceStartupFailure(feature, service, words);
        return { ready: false };
      }
      return { ready: true };
    }
    if (!service.installable) return { ready: true };

    const enableRes = await apiFetch(`/api/services/${serviceId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const enablePayload = (await enableRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!enableRes.ok || enablePayload.ok === false) {
      toastServiceError(words, enablePayload.error ?? words.cannotEnable(words.serviceName));
      return { ready: false };
    }
    return waitForVoiceServiceReady(feature, words);
  } catch {
    toastServiceError(words, words.cannotConnectManager(words.serviceName));
    return { ready: false };
  }
}

export async function installVoiceService(
  feature: VoiceFeature,
  opts: { model?: string; port?: number },
  ui?: VoiceServiceUi,
): Promise<boolean> {
  const words = uiFor(feature, ui);
  const { serviceId } = FEATURE_SERVICES[feature];
  try {
    const res = await apiFetch(`/api/services/${serviceId}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; output?: string };
    if (!res.ok || payload.ok === false) {
      const detail = [payload.error ?? words.cannotInstall(words.serviceName), payload.output]
        .filter(Boolean)
        .join('\n');
      toastServiceInstallError(words, detail);
      return false;
    }
    return true;
  } catch {
    toastServiceInstallError(words, words.cannotConnectManager(words.serviceName));
    return false;
  }
}
