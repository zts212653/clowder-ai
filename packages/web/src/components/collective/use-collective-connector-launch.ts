'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  type CollectiveConnectionProjection,
  type CollectiveConnectorStatus,
  type LocalCollectiveServiceLaunch,
  normalizeCollectiveServiceUrl,
} from './collective-client';
import { preferredConnection } from './collective-connection-selection';

const STATUS_REFRESH_MS = 5_000;

export function useCollectiveConnectorLaunch(input: {
  readonly initialServiceUrl: string;
  readonly targetConnectionId?: string;
  readonly serviceInputUrl?: string;
  readonly automaticallySelectService: boolean;
}) {
  const selectedConnectionRef = useRef<string | undefined>(input.targetConnectionId);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | undefined>(input.targetConnectionId);
  const [status, setStatus] = useState<CollectiveConnectorStatus>();
  const [serviceInput, setServiceInput] = useState(input.serviceInputUrl ?? input.initialServiceUrl);
  const [launchUrl, setLaunchUrl] = useState(() => normalizeCollectiveServiceUrl(input.initialServiceUrl));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'provision' | 'reconnect' | 'revoke'>();
  const setServiceAddress = useCallback((nextServiceUrl: string, nextLaunchUrl = nextServiceUrl) => {
    setLaunchUrl(nextLaunchUrl);
    setServiceInput(nextServiceUrl);
  }, []);

  useEffect(() => {
    if (!input.targetConnectionId) return;
    selectedConnectionRef.current = input.targetConnectionId;
    setSelectedConnectionId(input.targetConnectionId);
  }, [input.targetConnectionId]);

  useEffect(() => {
    if (input.serviceInputUrl) setServiceInput(input.serviceInputUrl);
  }, [input.serviceInputUrl]);

  const load = useCallback(
    async (afterMutation = false) => {
      try {
        const body = await readConnectorStatus(afterMutation);
        setStatus(body);
        if (input.automaticallySelectService) {
          const nextServiceUrl = automaticallySelectedService(body, selectedConnectionRef.current);
          if (nextServiceUrl) setServiceAddress(nextServiceUrl);
        }
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Connector status failed');
      }
    },
    [input.automaticallySelectService, setServiceAddress],
  );

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), STATUS_REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [load]);

  const provisionLocalService = useCallback(async () => {
    setBusy('provision');
    setError(undefined);
    try {
      const response = await apiFetch('/api/plugins/collective-connector/service/provision', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as LocalCollectiveServiceLaunch & { error?: string };
      if (!response.ok || !body.service || !body.launchUrl) {
        throw new Error(body.error ?? `Service creation failed (${response.status})`);
      }
      const normalized = normalizeCollectiveServiceUrl(body.service.serviceUrl);
      if (!normalized || new URL(body.launchUrl).origin !== normalized) {
        throw new Error('Host returned an invalid local Service address');
      }
      setStatus((current) => (current ? { ...current, localService: body.service } : current));
      setServiceAddress(normalized, body.launchUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Service creation failed');
    } finally {
      setBusy(undefined);
    }
  }, [setServiceAddress]);

  const onPaired = useCallback(
    async (connectionId: string) => {
      selectedConnectionRef.current = connectionId;
      setSelectedConnectionId(connectionId);
      await load(true);
    },
    [load],
  );

  const mutateConnection = useCallback(
    async (operation: 'reconnect' | 'revoke', connectionId: string) => {
      if (operation === 'revoke' && !window.confirm('撤销后 Service 与 Host 都会拒绝此 endpoint 凭据。确认撤销？')) {
        return;
      }
      setBusy(operation);
      setError(undefined);
      try {
        const response = await apiFetch(
          `/api/plugins/collective-connector/${encodeURIComponent(connectionId)}/${operation}`,
          { method: 'POST' },
        );
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `${operation} failed (${response.status})`);
        if (operation === 'revoke') {
          selectedConnectionRef.current = undefined;
          setSelectedConnectionId(undefined);
        }
        await load(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `${operation} failed`);
      } finally {
        setBusy(undefined);
      }
    },
    [load],
  );

  const selectConnection = useCallback(
    (connection: CollectiveConnectionProjection) => {
      selectedConnectionRef.current = connection.connectionId;
      setSelectedConnectionId(connection.connectionId);
      setServiceAddress(connection.serviceUrl);
    },
    [setServiceAddress],
  );

  return {
    status,
    selectedConnectionId,
    serviceInput,
    setServiceInput,
    launchUrl,
    error,
    setError,
    busy,
    setServiceAddress,
    provisionLocalService,
    onPaired,
    mutateConnection,
    selectConnection,
  };
}

async function readConnectorStatus(afterMutation: boolean): Promise<CollectiveConnectorStatus> {
  const response = await apiFetch(
    '/api/plugins/collective-connector',
    undefined,
    afterMutation ? { afterCurrentGet: true } : undefined,
  );
  const body = (await response.json().catch(() => ({}))) as CollectiveConnectorStatus & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Connector status failed (${response.status})`);
  return body;
}

function automaticallySelectedService(
  status: CollectiveConnectorStatus,
  selectedConnectionId?: string,
): string | undefined {
  const connection = preferredConnection(status.connections, selectedConnectionId);
  if (connection) return connection.serviceUrl;
  return status.localService?.state === 'ready' ? status.localService.serviceUrl : undefined;
}
