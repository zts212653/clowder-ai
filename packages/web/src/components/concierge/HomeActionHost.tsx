'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useSettingsReadingEntry } from '../shell/useSettingsSourceReturn';
import { useHubSocket } from '../thread-chat/hub-socket-context';
import { applyHomeCommand, homeHubObservation } from './home-action-bridge';

/**
 * Authenticated Hub delivery consumer, mounted with the original shell across route changes.
 * It rides the page connection: the server delivers home commands to the socket id this
 * window registered, so every new connection registers again.
 */
export function HomeActionHost({ enabled = true }: { enabled?: boolean }) {
  const hub = useHubSocket();
  const router = useRouter();
  const capture = useSettingsReadingEntry();
  const ports = useRef({ router, capture });
  ports.current = { router, capture };
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const clientId = crypto.randomUUID();
    const pending = new Map<string, AbortController>();
    const consumed = new Map<string, number>();
    let windowLease: { clientToken: string; expiresAt: number } | undefined;
    let registering: Promise<void> | undefined;
    let connectionEpoch = 0;
    let suspended = false;
    const releaseLease = (lease: { clientToken: string }) => {
      void apiFetch(`/api/concierge/home/clients/${clientId}`, {
        method: 'DELETE',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientToken: lease.clientToken }),
      }).catch(() => {});
    };
    const release = () => {
      ++connectionEpoch;
      const lease = windowLease;
      windowLease = undefined;
      if (lease) releaseLease(lease);
    };
    const register = () => {
      const socketId = hub.connectedSocketId();
      if (disposed || suspended || !socketId) return Promise.resolve();
      if (windowLease && windowLease.expiresAt > Date.now()) return Promise.resolve();
      const epoch = connectionEpoch;
      registering ??= apiFetch('/api/concierge/home/clients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, socketId }),
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok || typeof value.clientToken !== 'string' || typeof value.expiresAt !== 'number')
            throw new Error('Home window not registered');
          if (disposed || suspended || hub.connectedSocketId() !== socketId || epoch !== connectionEpoch)
            releaseLease(value);
          else windowLease = value;
        })
        .finally(() => {
          registering = undefined;
          // A fresh connection supersedes the old registration; network failures do not retry.
          if (!disposed && !suspended && hub.connectedSocketId() && epoch !== connectionEpoch)
            void register().catch(() => {});
        });
      return registering;
    };
    const inspect = (_input: unknown, ack?: (state: unknown) => void) => {
      void register()
        .then(() => ack?.(!disposed && windowLease ? homeHubObservation(clientId, windowLease.clientToken) : null))
        .catch(() => ack?.(null));
    };
    const execute = (
      data: { token?: unknown; clientId?: unknown; expiresAt?: unknown },
      ack?: (receipt: unknown) => void,
    ) => {
      for (const [past, expiresAt] of consumed) if (expiresAt <= Date.now()) consumed.delete(past);
      const token = typeof data?.token === 'string' && /^[0-9a-f-]{36}$/.test(data.token) ? data.token : null;
      if (
        disposed ||
        !windowLease ||
        data?.clientId !== clientId ||
        !token ||
        typeof data.expiresAt !== 'number' ||
        data.expiresAt <= Date.now() ||
        data.expiresAt > Date.now() + 10_000 ||
        consumed.has(token) ||
        consumed.size >= 128
      ) {
        ack?.({ token, clientId, status: 'blocked' });
        return;
      }
      consumed.set(token, data.expiresAt);
      const clientToken = windowLease.clientToken;
      const controller = new AbortController();
      pending.set(token, controller);
      void applyHomeCommand({
        token,
        clientId,
        clientToken,
        signal: controller.signal,
        navigate: (path) => ports.current.router.push(path),
        captureBeforeSettings: () => ports.current.capture(),
      })
        .catch(() => ({ status: 'unconfirmed' as const, reason: 'hub_operation_not_confirmed' }))
        .then((receipt) => {
          pending.delete(token);
          ack?.({ token, clientId, clientToken, ...receipt });
        });
    };
    const cancel = (data: { token?: string; clientId?: string }) => {
      if (data?.clientId === clientId && data.token) pending.get(data.token)?.abort('request_changed');
    };
    const releaseListeners = [
      hub.on('home:inspect', inspect),
      hub.on('home:execute', execute),
      hub.on('home:cancel', cancel),
      hub.on('disconnect', () => {
        release();
        for (const controller of pending.values()) controller.abort('hub_disconnected');
      }),
      // Runs now when already connected; the runtime that owns the connection also restores it.
      hub.onConnected(() => {
        void register().catch(() => {});
      }),
    ];
    const recover = () => {
      if (!disposed && !suspended) void register().catch(() => {});
    };
    const hide = () => {
      suspended = true;
      release();
      for (const controller of pending.values()) controller.abort('hub_page_hidden');
    };
    const show = () => {
      suspended = false;
      recover();
    };
    window.addEventListener('online', recover);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      disposed = true;
      window.removeEventListener('online', recover);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      for (const releaseListener of releaseListeners) releaseListener();
      release();
      for (const controller of pending.values()) controller.abort('hub_unmounted');
    };
  }, [enabled, hub]);
  return null;
}
