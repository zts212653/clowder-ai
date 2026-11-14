import { useSyncExternalStore } from 'react';
import { apiSessionIdentity } from '@/utils/api-session-identity';

export type PersonMaintenanceDraft =
  | { action: 'redact_item'; personId: string; item: { kind: 'claim' | 'event'; id: string }; expectedRevision: string }
  | { action: 'withdraw' | 'forget'; receiptId: string; expectedRevision: string };
export type PendingPersonMaintenance = PersonMaintenanceDraft & { requestId: string };
const prefix = 'cat-cafe:person-maintenance:v1:';
const listeners = new Set<() => void>();
const busyOwners = new Set<string>();
let version = 0;
const ownerPrefix = (owner: string) => `${prefix}${encodeURIComponent(owner)}:`;
const key = (owner: string, requestId: string) => `${ownerPrefix(owner)}${requestId}`;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function parsePending(rawValue: string | null): PendingPersonMaintenance | null {
  try {
    const raw: unknown = JSON.parse(rawValue ?? 'null');
    if (
      !record(raw) ||
      typeof raw.requestId !== 'string' ||
      raw.requestId.length < 32 ||
      typeof raw.expectedRevision !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(raw.expectedRevision)
    )
      return null;
    if (
      raw.action === 'redact_item' &&
      typeof raw.personId === 'string' &&
      record(raw.item) &&
      ['claim', 'event'].includes(String(raw.item.kind)) &&
      typeof raw.item.id === 'string'
    )
      return raw as PendingPersonMaintenance;
    if ((raw.action === 'withdraw' || raw.action === 'forget') && typeof raw.receiptId === 'string')
      return raw as PendingPersonMaintenance;
  } catch {
    /* No mutation is attempted without a recoverable coordinate. */
  }
  return null;
}
export function readPendingPersonMaintenance(owner: string | null): PendingPersonMaintenance | null {
  if (!owner || typeof localStorage === 'undefined') return null;
  try {
    const keys = Object.keys(localStorage)
      .filter((stored) => stored.startsWith(ownerPrefix(owner)))
      .sort();
    for (const stored of keys) {
      const command = parsePending(localStorage.getItem(stored));
      if (command && stored === key(owner, command.requestId)) return command;
    }
  } catch {
    // A blocked storage area cannot authorize a new mutation.
  }
  return null;
}
function emit() {
  version++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (!event.key || event.key.startsWith(prefix)) emit();
  };
  window.addEventListener('storage', changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', changed);
  };
}
export function usePendingPersonMaintenance() {
  const { ownerUserId: owner } = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return { owner, pending: readPendingPersonMaintenance(owner), busy: !!owner && busyOwners.has(owner) };
}
export function rememberPersonMaintenance(owner: string, draft: PersonMaintenanceDraft): PendingPersonMaintenance {
  if (readPendingPersonMaintenance(owner)) throw new Error('请先确认上一次操作的结果。');
  const command: PendingPersonMaintenance = { ...draft, requestId: `person_maintenance_${crypto.randomUUID()}` };
  // Different tabs can pass the initial check concurrently. Exact request keys
  // retain both coordinates instead of overwriting the first confirmed operation.
  const commandKey = key(owner, command.requestId);
  localStorage.setItem(commandKey, JSON.stringify(command));
  if (parsePending(localStorage.getItem(commandKey))?.requestId !== command.requestId)
    throw new Error('无法保存恢复坐标。');
  emit();
  return command;
}
export function settlePersonMaintenance(owner: string, command: PendingPersonMaintenance) {
  localStorage.removeItem(key(owner, command.requestId));
  emit();
}
export function beginPersonMaintenance(owner: string): boolean {
  if (busyOwners.has(owner)) return false;
  busyOwners.add(owner);
  emit();
  return true;
}
export function finishPersonMaintenance(owner: string) {
  busyOwners.delete(owner);
  emit();
}
