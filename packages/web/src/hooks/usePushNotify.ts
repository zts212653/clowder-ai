'use client';

/**
 * usePushNotify — 管理 Web Push 订阅状态
 *
 * - 检查浏览器/PWA 是否支持推送
 * - 管理订阅 (subscribe/unsubscribe)
 * - 从后端获取 VAPID 公钥
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/** Convert base64url VAPID key to Uint8Array for pushManager.subscribe */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export interface UsePushNotifyReturn {
  /** Browser supports Web Push + SW is available */
  isSupported: boolean;
  /** Browser notification permission */
  permission: NotificationPermission | 'unsupported';
  /** Currently subscribed to push notifications */
  isSubscribed: boolean;
  /** Loading state during subscribe/unsubscribe */
  isLoading: boolean;
  /** Environment hint for push diagnostics (e.g. dev mode SW not registered) */
  environmentHint: string | null;
  /** Last actionable error from subscribe/unsubscribe/test flows */
  lastError: string | null;
  /** Server-side status matrix for push capability/subscription/delivery */
  status: PushStatusPayload | null;
  /** Subscribe to push notifications (triggers permission prompt) */
  subscribe: () => Promise<void>;
  /** Unsubscribe from push notifications */
  unsubscribe: () => Promise<void>;
  /** Send a test push to verify it works */
  sendTest: () => Promise<{ ok: boolean; message: string; deliverySummary?: PushDeliverySummary | null }>;
}

export interface PushDeliverySummary {
  attempted: number;
  delivered: number;
  failed: number;
  removed: number;
}

export interface PushStatusPayload {
  capability: {
    enabled: boolean;
    vapidPublicKeyConfigured: boolean;
    pushServiceConfigured: boolean;
  };
  subscription: {
    count: number;
    targets: Array<{ endpoint: string; createdAt: number; uaFamily: string }>;
  };
  delivery: {
    lastAttemptAt: number | null;
    lastHttpStatus: number | null;
    lastResult: 'ok' | 'error' | 'not_attempted';
    lastError: string | null;
  };
  errorHints: string[];
}

const DEV_PWA_HINT = '开发模式下若无法订阅系统通知，请用 ENABLE_PWA_IN_DEV=1 启动，或改用 build+start 进行推送验证。';

function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function usePushNotify(): UsePushNotifyReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<PushStatusPayload | null>(null);
  const [environmentHint, setEnvironmentHint] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const vapidKeyRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async (): Promise<PushStatusPayload | null> => {
    try {
      const res = await apiFetch('/api/push/status');
      if (!res.ok) {
        setStatus(null);
        return null;
      }
      const payload = (await res.json()) as PushStatusPayload;
      setStatus(payload);
      return payload;
    } catch {
      setStatus(null);
      return null;
    }
  }, []);

  // Check support + current subscription on mount
  useEffect(() => {
    const check = async () => {
      if (typeof window === 'undefined') return;
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setPermission('unsupported');
        setEnvironmentHint('当前浏览器不支持系统推送通知。');
        return;
      }
      setIsSupported(true);
      setPermission(Notification.permission);

      try {
        await fetchStatus();
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          setIsSubscribed(false);
          setEnvironmentHint(
            isDevelopmentMode() ? DEV_PWA_HINT : 'Service Worker 未注册，系统通知暂不可用。请刷新页面后重试。',
          );
          return;
        }
        const sub = await reg.pushManager.getSubscription();
        setIsSubscribed(sub !== null);
        setEnvironmentHint(null);
      } catch {
        setEnvironmentHint(
          isDevelopmentMode() ? DEV_PWA_HINT : 'Service Worker 尚未就绪，系统通知暂不可用。请稍后重试。',
        );
      }
    };
    void check();
  }, [fetchStatus]);

  const fetchVapidKey = useCallback(async (): Promise<string | null> => {
    if (vapidKeyRef.current) return vapidKeyRef.current;
    try {
      const res = await apiFetch('/api/push/vapid-public-key');
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.enabled || !data.key) return null;
      vapidKeyRef.current = data.key as string;
      return data.key as string;
    } catch {
      return null;
    }
  }, []);

  const subscribe = useCallback(async () => {
    setIsLoading(true);
    setLastError(null);
    try {
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== 'granted') {
        setLastError('通知权限未授权，无法开启系统通知。');
        return;
      }

      const vapidKey = await fetchVapidKey();
      if (!vapidKey) {
        console.warn('[push] VAPID key not available — push disabled on server');
        setLastError('推送服务未配置（VAPID key 不可用）。');
        return;
      }

      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        throw new Error(isDevelopmentMode() ? DEV_PWA_HINT : 'Service Worker 未注册，暂无法订阅系统通知。');
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
      });

      const subJson = sub.toJSON();
      const res = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: {
            endpoint: subJson.endpoint,
            keys: subJson.keys,
          },
          userAgent: navigator.userAgent,
        }),
      });

      if (!res.ok) {
        let serverMessage: string | null = null;
        try {
          const payload = (await res.json()) as { error?: unknown };
          if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
            serverMessage = payload.error;
          }
        } catch {
          // ignore non-json body
        }
        await sub.unsubscribe().catch(() => {});
        throw new Error(serverMessage ?? `Push subscribe failed (HTTP ${res.status})`);
      }

      setIsSubscribed(true);
      setEnvironmentHint(null);
      await fetchStatus();
    } catch (err) {
      console.error('[push] Subscribe failed:', err);
      const message = err instanceof Error ? err.message : '开启推送失败，请稍后重试。';
      setLastError(message);
      setIsSubscribed(false);
    } finally {
      setIsLoading(false);
    }
  }, [fetchStatus, fetchVapidKey]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    setLastError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        setIsSubscribed(false);
        setEnvironmentHint(
          isDevelopmentMode() ? DEV_PWA_HINT : 'Service Worker 未注册，当前设备没有可取消的系统通知订阅。',
        );
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await apiFetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
      }
      setIsSubscribed(false);
      await fetchStatus();
    } catch (err) {
      console.error('[push] Unsubscribe failed:', err);
      const message = err instanceof Error ? err.message : '关闭推送失败，请稍后重试。';
      setLastError(message);
    } finally {
      setIsLoading(false);
    }
  }, [fetchStatus]);

  const sendTest = useCallback(async () => {
    setLastError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await apiFetch('/api/push/test', { method: 'POST', signal: controller.signal });
      const payload = (await res.json().catch(() => ({}))) as {
        message?: unknown;
        error?: unknown;
        deliverySummary?: PushDeliverySummary;
      };
      const serverMessage =
        typeof payload.message === 'string' && payload.message.trim().length > 0
          ? payload.message
          : typeof payload.error === 'string' && payload.error.trim().length > 0
            ? payload.error
            : null;

      if (!res.ok) {
        const failureMessage = serverMessage ?? `请求失败（HTTP ${res.status}）`;
        setLastError(failureMessage);
        await fetchStatus();
        return {
          ok: false,
          message: failureMessage,
          deliverySummary: payload.deliverySummary ?? null,
        };
      }

      await fetchStatus();
      return {
        ok: true,
        message: serverMessage ?? '测试推送已发送',
        deliverySummary: payload.deliverySummary ?? null,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setLastError('请求超时，请检查 API 连接或推送配置');
        await fetchStatus();
        return {
          ok: false,
          message: '请求超时，请检查 API 连接或推送配置',
          deliverySummary: null,
        };
      }
      console.error('[push] Test push failed:', err);
      setLastError('网络异常，测试通知发送失败');
      await fetchStatus();
      return {
        ok: false,
        message: '网络异常，测试通知发送失败',
        deliverySummary: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }, [fetchStatus]);

  return {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    environmentHint,
    lastError,
    status,
    subscribe,
    unsubscribe,
    sendTest,
  };
}
