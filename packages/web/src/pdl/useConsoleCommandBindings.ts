'use client';

import { useEffect } from 'react';
import { useHubSocket } from '@/components/thread-chat/hub-socket-context';
import type { PreviewOpenCommand } from '@/hooks/preview-auto-open-delivery';
import type { NavigateEvent } from '@/hooks/useWorkspaceNavigate';
import type { WorkspaceNavigationReceipt } from '@/hooks/workspace-navigation-pending';
import { apiFetch } from '@/utils/api-client';
import { request } from './owner-api';

interface HomeLease {
  clientToken: string;
  expiresAt: number;
}
interface HomeObservation {
  route: string;
  threadId: string | null;
  composer: boolean;
  sections: { id: string; label: string }[];
}
interface HomeGrant {
  kind: 'navigate' | 'updated';
  clientId: string;
  baseRoute: string;
  expiresAt: number;
  action?: { kind: string; sectionId?: string; threadId?: string };
}

/** One-shot commands run through the console's existing action bindings. */
export function useConsoleCommandBindings(enabled: boolean) {
  const hub = useHubSocket();
  useEffect(() => {
    if (!enabled) return;
    const stopJoining = hub.retainRoom('workspace:navigate:ack');
    const releases: (() => void)[] = [];
    const listen: typeof hub.on = (event, listener) => {
      const release = hub.on(event, listener);
      releases.push(release);
      return release;
    };
    const clientId = crypto.randomUUID();
    const pending = new Map<string, AbortController>();
    const consumed = new Map<string, number>();
    let suspended = false;
    const preview = (event: Event) => {
      const command = (event as CustomEvent<PreviewOpenCommand>).detail;
      command.ran = window.clowderChat.emit('preview:auto-open', command.data) === true;
    };
    window.addEventListener('preview:auto-open', preview);
    let active = true,
      epoch = 0,
      lease: HomeLease | undefined,
      registering: Promise<HomeLease | undefined> | undefined;
    const release = (value: HomeLease) => {
      void apiFetch(`/api/concierge/home/clients/${clientId}`, {
        method: 'DELETE',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientToken: value.clientToken }),
      }).catch(() => {});
    };
    const register = () => {
      const socketId = hub.connectedSocketId();
      if (!active || suspended || !socketId) return Promise.resolve(undefined);
      if (lease && lease.expiresAt > Date.now()) return Promise.resolve(lease);
      if (registering) return registering;
      const generation = epoch;
      const reading = request<HomeLease>('/api/concierge/home/clients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, socketId }),
      })
        .then((value) => {
          if (!active || suspended || generation !== epoch || hub.connectedSocketId() !== socketId) {
            release(value);
            return;
          }
          lease = value;
          window.clowderChat.dataOk('home');
          return value;
        })
        .finally(() => {
          if (registering === reading) registering = undefined;
          if (active && !suspended && hub.connectedSocketId() && generation !== epoch)
            void register().catch((error) => window.clowderChat.dataError('home', error));
        });
      registering = reading;
      return reading;
    };
    const disconnected = () => {
      ++epoch;
      if (lease) release(lease);
      lease = undefined;
      registering = undefined;
      pending.forEach((controller) => controller.abort());
    };
    releases.push(
      hub.onConnected(() => {
        void register().catch((error) => window.clowderChat.dataError('home', error));
      }),
    );
    listen('disconnect', disconnected);
    listen('home:inspect', (_input: unknown, acknowledge: (value: unknown) => void) => {
      void register()
        .then((value) => {
          const observed = window.clowderChat.emit('home:inspect', undefined) as HomeObservation | null;
          acknowledge(active && value && observed ? { clientId, clientToken: value.clientToken, ...observed } : null);
        })
        .catch(() => acknowledge(null));
    });
    listen(
      'home:execute',
      (data: { token: string; clientId: string; expiresAt: number }, acknowledge: (value: unknown) => void) => {
        for (const [past, expiresAt] of consumed) if (expiresAt <= Date.now()) consumed.delete(past);
        if (
          !active ||
          suspended ||
          !lease ||
          consumed.has(data.token) ||
          consumed.size >= 128 ||
          data.clientId !== clientId ||
          !/^[0-9a-f-]{36}$/.test(data.token) ||
          data.expiresAt <= Date.now() ||
          data.expiresAt > Date.now() + 10_000
        ) {
          acknowledge({ token: data.token, clientId, status: 'blocked' });
          return;
        }
        consumed.set(data.token, data.expiresAt);
        const clientToken = lease.clientToken,
          controller = new AbortController();
        pending.set(data.token, controller);
        const before = window.clowderChat.emit('home:inspect', undefined) as HomeObservation | null;
        void request<HomeGrant>(`/api/concierge/home/commands/${encodeURIComponent(data.token)}`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId, clientToken }),
        })
          .then(async (grant) => {
            if (
              controller.signal.aborted ||
              !before ||
              grant.clientId !== clientId ||
              grant.baseRoute !== before.route ||
              grant.expiresAt <= Date.now()
            )
              return false;
            return (await window.clowderChat.emit('home:execute', grant)) === true;
          })
          .then(
            (ran) => acknowledge({ token: data.token, clientId, clientToken, status: ran ? 'applied' : 'blocked' }),
            () => acknowledge({ token: data.token, clientId, clientToken, status: 'blocked' }),
          )
          .finally(() => pending.delete(data.token));
      },
    );
    listen('home:cancel', (data: { token: string; clientId: string }) => {
      if (data.clientId === clientId) pending.get(data.token)?.abort();
    });
    listen('workspace:navigate', (data: NavigateEvent, acknowledge?: (value: WorkspaceNavigationReceipt) => void) => {
      void Promise.resolve(window.clowderChat.emit('workspace:navigate', data)).then(
        (ran) => acknowledge?.({ eventId: data.eventId ?? '', status: ran === true ? 'applied' : 'blocked' }),
        () => acknowledge?.({ eventId: data.eventId ?? '', status: 'blocked' }),
      );
    });
    const recover = () => {
      void register().catch((error) => window.clowderChat.dataError('home', error));
    };
    const hide = () => {
      suspended = true;
      disconnected();
    };
    const show = () => {
      suspended = false;
      recover();
    };
    window.addEventListener('online', recover);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      active = false;
      window.removeEventListener('online', recover);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('preview:auto-open', preview);
      disconnected();
      stopJoining();
      releases.forEach((release) => release());
    };
  }, [enabled, hub]);
}
