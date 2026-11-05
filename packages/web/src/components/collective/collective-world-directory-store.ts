import type { CollectiveClientWorldDirectory, CollectiveWorldDirectoryMembership } from '@cat-cafe/shared';
import {
  clearWorldDirectoryCache,
  forgetCachedWorldDirectory,
  readRecoverableWorldDirectories,
  rememberCachedWorldDirectory,
  type WorldDirectoryRecoveryAuthority,
} from './collective-world-directory-cache';

export type { WorldDirectoryRecoveryAuthority } from './collective-world-directory-cache';

/**
 * Architecture cell: collective-runtime.
 * Map delta: add one read-only Host shell projection; the Service remains the only membership authority.
 * Why: the global Café rail needs verified world names after the exact Collective iframe leaves the route.
 */

export type WorldDirectoryObservationStatus =
  | 'checking'
  | 'ready'
  | 'session_required'
  | 'unavailable'
  | 'service_mismatch';

export interface WorldDirectoryServiceSnapshot {
  readonly serviceUrl: string;
  readonly bridgeId?: string;
  readonly expectedServiceInstanceId?: string;
  readonly serviceInstanceId?: string;
  readonly humanId?: string;
  readonly currentCollectiveId?: string;
  readonly revision: number;
  readonly observation: number;
  readonly status: WorldDirectoryObservationStatus;
  readonly memberships: readonly CollectiveWorldDirectoryMembership[];
}

export interface WorldDirectoryStoreSnapshot {
  readonly version: number;
  readonly services: readonly WorldDirectoryServiceSnapshot[];
}

type Listener = () => void;
const EMPTY_SNAPSHOT: WorldDirectoryStoreSnapshot = { version: 0, services: [] };
let snapshot = EMPTY_SNAPSHOT;
let observation = 0;
const listeners = new Set<Listener>();

export function getWorldDirectoryStoreSnapshot(): WorldDirectoryStoreSnapshot {
  return snapshot;
}

export function subscribeWorldDirectoryStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginWorldDirectoryObservation(input: {
  readonly serviceUrl: string;
  readonly bridgeId: string;
  readonly expectedServiceInstanceId?: string;
}): void {
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  if (!serviceUrl) return;
  const previous = snapshot.services.find((item) => item.serviceUrl === serviceUrl);
  const identityChanged = Boolean(
    previous?.serviceInstanceId &&
      input.expectedServiceInstanceId &&
      previous.serviceInstanceId !== input.expectedServiceInstanceId,
  );
  if (identityChanged) forgetCachedWorldDirectory(serviceUrl);
  const next: WorldDirectoryServiceSnapshot = {
    serviceUrl,
    bridgeId: input.bridgeId,
    ...(input.expectedServiceInstanceId ? { expectedServiceInstanceId: input.expectedServiceInstanceId } : {}),
    ...(!identityChanged && previous?.serviceInstanceId ? { serviceInstanceId: previous.serviceInstanceId } : {}),
    ...(!identityChanged && previous?.humanId ? { humanId: previous.humanId } : {}),
    ...(!identityChanged && previous?.currentCollectiveId ? { currentCollectiveId: previous.currentCollectiveId } : {}),
    revision: 0,
    observation: ++observation,
    status: 'checking',
    memberships: identityChanged ? [] : (previous?.memberships ?? []),
  };
  replaceService(next);
}

export function publishWorldDirectoryObservation(input: {
  readonly serviceUrl: string;
  readonly bridgeId: string;
  readonly directory: CollectiveClientWorldDirectory;
}): void {
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  if (!serviceUrl) return;
  const previous = snapshot.services.find((item) => item.serviceUrl === serviceUrl);
  if (!previous || !isCurrentDirectoryPublication(previous, input)) return;
  const serviceInstanceId = input.directory.serviceInstanceId;
  if (
    serviceInstanceId &&
    previous.expectedServiceInstanceId !== undefined &&
    serviceInstanceId !== previous.expectedServiceInstanceId
  )
    return;
  const identityChanged = Boolean(
    serviceInstanceId && previous.serviceInstanceId && serviceInstanceId !== previous.serviceInstanceId,
  );
  if (identityChanged) forgetCachedWorldDirectory(serviceUrl);
  const common = {
    ...previous,
    ...(serviceInstanceId ? { serviceInstanceId } : {}),
    revision: input.directory.revision,
    observation: ++observation,
  };
  if (input.directory.state === 'ready') {
    const ready = {
      ...common,
      status: 'ready',
      humanId: input.directory.humanId,
      ...(input.directory.currentCollectiveId
        ? { currentCollectiveId: input.directory.currentCollectiveId }
        : { currentCollectiveId: undefined }),
      memberships: uniqueMemberships(input.directory.memberships),
    } satisfies WorldDirectoryServiceSnapshot;
    replaceService(ready);
    rememberReadyService(ready);
    return;
  }
  if (input.directory.state === 'session_required') {
    forgetCachedWorldDirectory(serviceUrl);
    replaceService({
      ...common,
      status: 'session_required',
      humanId: undefined,
      currentCollectiveId: undefined,
      memberships: [],
    });
    return;
  }
  replaceService({
    ...common,
    status: 'unavailable',
    ...(identityChanged ? { humanId: undefined, currentCollectiveId: undefined } : {}),
    memberships: identityChanged ? [] : previous.memberships,
  });
}

export function failWorldDirectoryObservation(input: {
  readonly serviceUrl: string;
  readonly bridgeId: string;
  readonly failure: 'service_mismatch';
}): void {
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  if (!serviceUrl) return;
  const previous = snapshot.services.find((item) => item.serviceUrl === serviceUrl);
  if (!previous) return;
  if (previous.bridgeId !== input.bridgeId) return;
  forgetCachedWorldDirectory(serviceUrl);
  replaceService({
    ...previous,
    status: input.failure,
    humanId: undefined,
    currentCollectiveId: undefined,
    memberships: [],
    observation: ++observation,
  });
}

export function endWorldDirectoryObservation(input: { readonly serviceUrl: string; readonly bridgeId: string }): void {
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  const previous = snapshot.services.find((item) => item.serviceUrl === serviceUrl);
  if (!previous) return;
  if (previous.bridgeId !== input.bridgeId) return;
  const retained = { ...previous };
  delete retained.bridgeId;
  replaceService({
    ...retained,
    status: previous.status === 'ready' ? 'checking' : previous.status,
    observation: ++observation,
  });
}

export function recoverWorldDirectoryCache(authorities: readonly WorldDirectoryRecoveryAuthority[]): void {
  for (const cached of readRecoverableWorldDirectories(authorities)) {
    const previous = snapshot.services.find((item) => item.serviceUrl === cached.serviceUrl);
    if (previous?.status === 'unavailable') {
      // The live failure owns status and generation; a compatible cache may only restore display labels.
      const expectedServiceMismatch =
        previous.expectedServiceInstanceId !== undefined &&
        previous.expectedServiceInstanceId !== cached.serviceInstanceId;
      const observedServiceMismatch =
        previous.serviceInstanceId !== undefined && previous.serviceInstanceId !== cached.serviceInstanceId;
      const humanMismatch = previous.humanId !== undefined && previous.humanId !== cached.humanId;
      if (previous.memberships.length === 0 && !expectedServiceMismatch && !observedServiceMismatch && !humanMismatch) {
        replaceService({
          ...previous,
          serviceInstanceId: cached.serviceInstanceId,
          humanId: cached.humanId,
          observation: ++observation,
          memberships: cached.memberships,
        });
      }
      continue;
    }
    if (
      previous?.status === 'ready' ||
      previous?.status === 'session_required' ||
      previous?.status === 'service_mismatch'
    )
      continue;
    replaceService({
      ...previous,
      serviceUrl: cached.serviceUrl,
      serviceInstanceId: cached.serviceInstanceId,
      humanId: cached.humanId,
      currentCollectiveId: undefined,
      revision: previous?.revision ?? 0,
      observation: ++observation,
      status: 'checking',
      memberships: cached.memberships,
    });
  }
}

export function resetWorldDirectoryStoreForTests(input: { readonly preserveCache?: boolean } = {}): void {
  observation = 0;
  snapshot = EMPTY_SNAPSHOT;
  if (!input.preserveCache) clearWorldDirectoryCache();
  listeners.forEach((listener) => {
    listener();
  });
}

function replaceService(service: WorldDirectoryServiceSnapshot): void {
  const index = snapshot.services.findIndex((item) => item.serviceUrl === service.serviceUrl);
  const services = [...snapshot.services];
  if (index === -1) services.push(service);
  else services[index] = service;
  snapshot = { version: snapshot.version + 1, services };
  listeners.forEach((listener) => {
    listener();
  });
}

function isCurrentDirectoryPublication(
  previous: WorldDirectoryServiceSnapshot,
  input: { readonly bridgeId: string; readonly directory: CollectiveClientWorldDirectory },
): boolean {
  return (
    previous.bridgeId === input.bridgeId &&
    input.directory.bridgeId === input.bridgeId &&
    input.directory.revision > previous.revision
  );
}

function uniqueMemberships(
  memberships: readonly CollectiveWorldDirectoryMembership[],
): readonly CollectiveWorldDirectoryMembership[] {
  const seen = new Set<string>();
  return memberships.filter((membership) => {
    if (seen.has(membership.collectiveId)) return false;
    seen.add(membership.collectiveId);
    return true;
  });
}

function normalizeServiceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function rememberReadyService(service: WorldDirectoryServiceSnapshot): void {
  if (!service.serviceInstanceId || !service.humanId) return;
  rememberCachedWorldDirectory({
    serviceUrl: service.serviceUrl,
    serviceInstanceId: service.serviceInstanceId,
    humanId: service.humanId,
    memberships: service.memberships,
  });
}
