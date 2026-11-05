import { useCallback, useEffect, useState } from 'react';
import { connectDeviceVoiceService, type DeviceVoiceService } from './device-voice-service.js';

/** Namespace contains Service, Collective and authenticated Human. No endpoint or credential is shared with another member. */
export function useDeviceVoiceService(namespace: string) {
  const key = `collective-device-voice:${namespace}`;
  const [service, setService] = useState<{ key: string; value: DeviceVoiceService }>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const read = useCallback(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    const value = read();
    setService(undefined);
    if (value) {
      setChecking(true);
      void connectDeviceVoiceService(value, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setService({ key, value });
        })
        .catch(() => {
          if (!controller.signal.aborted) setError('这台设备的转写服务暂不可用。');
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }
    return () => controller.abort();
  }, [key, read]);
  return {
    service: service?.key === key ? service.value : undefined,
    error,
    checking,
    savedEndpoint: read(),
    async configure(value: string, signal: AbortSignal) {
      setChecking(true);
      setError(undefined);
      try {
        const connected = await connectDeviceVoiceService(value, signal);
        signal.throwIfAborted();
        localStorage.setItem(key, connected.endpoint);
        setService({ key, value: connected });
        return true;
      } catch (error) {
        if (!signal.aborted) setError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        if (!signal.aborted) setChecking(false);
      }
    },
    remove() {
      localStorage.removeItem(key);
      setService(undefined);
      setError(undefined);
    },
  };
}
