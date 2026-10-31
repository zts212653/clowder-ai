import {
  type RoutingContextReadModelV1,
  type RoutingPreferenceCreateCommandV1,
  type RoutingPreferenceRetireCommandV1,
  type RoutingPreferenceSupersedeCommandV1,
  type RoutingSignalCloseCommandV1,
  type RoutingSignalMarkCommandV1,
  routingContextReadModelV1Schema,
} from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export class RoutingContextCommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RoutingContextCommandError';
  }
}

export async function fetchRoutingContext(signal?: AbortSignal): Promise<RoutingContextReadModelV1> {
  const response = await apiFetch('/api/routing-context/snapshot', { signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Routing context request failed (${response.status})`);
  }
  return routingContextReadModelV1Schema.parse(await response.json());
}

async function sendRoutingCommand(path: string, body: object): Promise<unknown> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new RoutingContextCommandError(
      payload?.error ?? `Routing context command failed (${response.status})`,
      response.status,
    );
  }
  return response.json();
}

export function markRoutingSignal(command: RoutingSignalMarkCommandV1): Promise<unknown> {
  return sendRoutingCommand('/api/routing-context/signals', command);
}

export function closeRoutingSignal(
  eventId: string,
  action: 'recover' | 'retract',
  command: RoutingSignalCloseCommandV1,
): Promise<unknown> {
  return sendRoutingCommand(`/api/routing-context/signals/${encodeURIComponent(eventId)}/${action}`, command);
}

export function createRoutingPreference(command: RoutingPreferenceCreateCommandV1): Promise<unknown> {
  return sendRoutingCommand('/api/routing-context/preferences', command);
}

export function supersedeRoutingPreference(
  preferenceId: string,
  command: RoutingPreferenceSupersedeCommandV1,
  action: 'renew' | 'supersede' = 'supersede',
): Promise<unknown> {
  return sendRoutingCommand(`/api/routing-context/preferences/${encodeURIComponent(preferenceId)}/${action}`, command);
}

export function retireRoutingPreference(
  preferenceId: string,
  command: RoutingPreferenceRetireCommandV1,
): Promise<unknown> {
  return sendRoutingCommand(`/api/routing-context/preferences/${encodeURIComponent(preferenceId)}/retire`, command);
}
