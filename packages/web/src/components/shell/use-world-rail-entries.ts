'use client';

import { useMemo, useSyncExternalStore } from 'react';
import {
  getWorldDirectoryStoreSnapshot,
  subscribeWorldDirectoryStore,
  type WorldDirectoryObservationStatus,
  type WorldDirectoryStoreSnapshot,
} from '../collective/collective-world-directory-store';

export type WorldRailEntryStatus = 'ready' | 'checking' | 'unavailable';

export interface WorldRailEntry {
  readonly key: string;
  readonly serviceUrl: string;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly name: string;
  readonly role: 'steward' | 'member';
  readonly href: string;
  readonly active: boolean;
  readonly status: WorldRailEntryStatus;
  readonly statusText: string;
}

export type WorldRailDirectoryStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'session_required'
  | 'unavailable'
  | 'service_mismatch';

export interface WorldRailDirectory {
  readonly status: WorldRailDirectoryStatus;
  readonly statusText: string;
  readonly worlds: readonly WorldRailEntry[];
}

interface ObservedWorldRailEntry {
  readonly entry: WorldRailEntry;
  readonly observation: number;
}

export function useWorldRailEntries(): WorldRailDirectory {
  const snapshot = useSyncExternalStore(
    subscribeWorldDirectoryStore,
    getWorldDirectoryStoreSnapshot,
    getWorldDirectoryStoreSnapshot,
  );
  return useMemo(() => projectWorldRailDirectory(snapshot), [snapshot]);
}

export function projectWorldRailDirectory(snapshot: WorldDirectoryStoreSnapshot): WorldRailDirectory {
  const entries = projectWorlds(snapshot);
  const status = entries.length > 0 ? populatedDirectoryStatus(entries) : emptyDirectoryStatus(snapshot);
  return { status, statusText: directoryStatusText(status), worlds: entries };
}

function projectWorlds(snapshot: WorldDirectoryStoreSnapshot): readonly WorldRailEntry[] {
  const worlds = new Map<string, ObservedWorldRailEntry>();
  for (const service of snapshot.services) {
    if (!service.serviceInstanceId) continue;
    const status = worldStatus(service.status);
    if (!status) continue;
    for (const membership of service.memberships) {
      const key = `${service.serviceInstanceId}:${membership.collectiveId}`;
      const candidate: ObservedWorldRailEntry = {
        observation: service.observation,
        entry: {
          key,
          serviceUrl: service.serviceUrl,
          serviceInstanceId: service.serviceInstanceId,
          collectiveId: membership.collectiveId,
          name: membership.name,
          role: membership.role,
          href: exactWorldHref(service.serviceUrl, service.serviceInstanceId, membership.collectiveId),
          active: service.status === 'ready' && service.currentCollectiveId === membership.collectiveId,
          status,
          statusText: worldStatusText(status),
        },
      };
      upsertWorld(worlds, candidate);
    }
  }
  return [...worlds.values()].map((world) => world.entry);
}

function upsertWorld(worlds: Map<string, ObservedWorldRailEntry>, candidate: ObservedWorldRailEntry): void {
  const previous = worlds.get(candidate.entry.key);
  if (!previous) {
    worlds.set(candidate.entry.key, candidate);
    return;
  }
  const candidateRank = statusRank(candidate.entry.status);
  const previousRank = statusRank(previous.entry.status);
  if (
    candidateRank > previousRank ||
    (candidateRank === previousRank && candidate.observation > previous.observation)
  ) {
    worlds.set(candidate.entry.key, candidate);
  }
}

function populatedDirectoryStatus(entries: readonly WorldRailEntry[]): WorldRailDirectoryStatus {
  if (entries.some((world) => world.status === 'ready')) return 'ready';
  if (entries.some((world) => world.status === 'checking')) return 'checking';
  return 'unavailable';
}

function exactWorldHref(serviceUrl: string, serviceInstanceId: string, collectiveId: string): string {
  const params = new URLSearchParams({ serviceUrl, serviceInstanceId, collectiveId });
  return `/collective?${params.toString()}`;
}

function worldStatus(status: WorldDirectoryObservationStatus): WorldRailEntryStatus | undefined {
  switch (status) {
    case 'ready':
    case 'checking':
    case 'unavailable':
      return status;
    default:
      return undefined;
  }
}

function statusRank(status: WorldRailEntryStatus): number {
  if (status === 'ready') return 3;
  if (status === 'checking') return 2;
  return 1;
}

function worldStatusText(status: WorldRailEntryStatus): string {
  if (status === 'ready') return '可直接打开';
  if (status === 'checking') return '打开后确认当前账号的访问资格';
  return '暂时连不上这个共同体';
}

function emptyDirectoryStatus(snapshot: WorldDirectoryStoreSnapshot): WorldRailDirectoryStatus {
  const statuses = snapshot.services.map((service) => service.status);
  if (statuses.includes('service_mismatch')) return 'service_mismatch';
  if (statuses.includes('session_required')) return 'session_required';
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('checking')) return 'checking';
  return 'unknown';
}

function directoryStatusText(status: WorldRailDirectoryStatus): string {
  switch (status) {
    case 'ready':
      return '已读取当前账号的共同体';
    case 'checking':
      return '正在确认当前账号的共同体';
    case 'session_required':
      return '需要重新登录共同体';
    case 'unavailable':
      return '暂时连不上共同体';
    case 'service_mismatch':
      return '共同体连接已经变化，请重新连接';
    case 'unknown':
      return '打开后查看当前账号的共同体';
  }
}
