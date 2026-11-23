import { refreshCatsNow } from '@/hooks/useCatData';
import { request, write } from './owner-api';

export async function saveAccount(id: string, value: string) {
  const receipt = await write(`/api/accounts/${encodeURIComponent(id)}`, JSON.parse(value), 'PATCH');
  await refreshCatsNow();
  return receipt;
}
export const saveCapability = (value: string) => write('/api/capabilities', JSON.parse(value), 'PATCH');
export const removeMcp = (id: string, value: string) =>
  request(`/api/capabilities/mcp/${encodeURIComponent(id)}?${new URLSearchParams(JSON.parse(value))}`, {
    method: 'DELETE',
  });
export const saveMountRules = (value: string) => write('/api/mount-rules', JSON.parse(value), 'PUT');
export const saveInjectionSegment = (id: string, value: string) =>
  write(`/api/prompt-injection/segment/${encodeURIComponent(id)}/override`, { content: value }, 'PUT');
export const resetInjectionSegment = (id: string) =>
  write(`/api/prompt-injection/segment/${encodeURIComponent(id)}/override`, {}, 'DELETE');
export const saveThreadEffort = (id: string, catId: string, effort: string) =>
  write(
    `/api/threads/${encodeURIComponent(id)}/members/${encodeURIComponent(catId)}/effort`,
    { effort: effort || null },
    'PATCH',
  );
export const saveThreadSpeed = (id: string, catId: string, speed: string) =>
  write(
    `/api/threads/${encodeURIComponent(id)}/members/${encodeURIComponent(catId)}/speed`,
    { speed: speed || null },
    'PATCH',
  );
export const saveThreadGoal = (id: string, value: string) =>
  write(`/api/threads/${encodeURIComponent(id)}/goal`, JSON.parse(value), 'PUT');

// Browser subscription flow retained from usePushNotify; next-pwa owns /sw.js.
export async function readPushClient() {
  const enabled = document.documentElement.dataset.catCafePwaRetirement === 'enabled';
  const supported =
    window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const registration = enabled && supported ? await navigator.serviceWorker.getRegistration() : undefined;
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  return {
    isSupported: !!registration,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    isSubscribed: subscription !== null,
    worker: !enabled ? 'disabled' : !supported ? 'unsupported' : registration ? 'registered' : 'missing',
  };
}

export async function subscribePush() {
  if (document.documentElement.dataset.catCafePwaRetirement !== 'enabled') throw new Error('PWA disabled');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知权限未授权，无法开启系统通知。');
  const vapid = await request<{ key: string | null; enabled: boolean }>('/api/push/vapid-public-key');
  if (!vapid.enabled || !vapid.key) throw new Error('推送服务未配置（VAPID key 不可用）。');
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error('Service Worker unavailable');
  const padding = '='.repeat((4 - (vapid.key.length % 4)) % 4);
  const base64 = (vapid.key + padding).replace(/-/g, '+').replace(/_/g, '/');
  const key = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key.buffer,
  });
  const json = subscription.toJSON();
  try {
    await write('/api/push/subscribe', {
      subscription: { endpoint: json.endpoint, keys: json.keys },
      userAgent: navigator.userAgent,
    });
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }
}

export async function unsubscribePush() {
  if (document.documentElement.dataset.catCafePwaRetirement !== 'enabled') throw new Error('PWA disabled');
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error('Service Worker unavailable');
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    if (!(await subscription.unsubscribe())) throw new Error('Push unsubscribe failed');
    await write('/api/push/subscribe', { endpoint: subscription.endpoint }, 'DELETE');
  }
}
