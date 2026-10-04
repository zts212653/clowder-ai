import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WorktreeEntry } from '../workspace-security.js';
import { WorkspaceSecurityError } from '../workspace-security-error.js';
import {
  canonicalLinkedRootId,
  findLinkedRootAt,
  mutateLinkedRootState,
  readLinkedRootState,
} from './workspace-linked-root-store.js';

function toLinkedEntry(name: string, rootPath: string): WorktreeEntry {
  return {
    id: `linked_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    root: resolve(rootPath),
    branch: name,
    head: 'linked',
  };
}

/** Environment roots retain their legacy aliases; persisted connections are separate entries. */
export function getLinkedRoots(): WorktreeEntry[] {
  // From env var
  const envRoots: WorktreeEntry[] = [];
  const raw = process.env.WORKSPACE_LINKED_ROOTS;
  if (raw) {
    for (const segment of raw.split(',')) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      envRoots.push(toLinkedEntry(trimmed.slice(0, colonIdx).trim(), trimmed.slice(colonIdx + 1).trim()));
    }
  }
  return envRoots;
}

/** Return both environment grants and persisted shared connections, including alias collisions. */
export async function getLinkedRootsAsync(): Promise<WorktreeEntry[]> {
  const envRoots = getLinkedRoots();
  const state = readLinkedRootState();
  const configRoots = state.roots.map((entry) => {
    const legacy = toLinkedEntry(entry.name, entry.path);
    return {
      ...legacy,
      ...(entry.id ? { id: entry.id, rootIdentity: entry.id } : {}),
      ...(entry.legacyAliases ? { legacyAliases: entry.legacyAliases } : {}),
      removable: true,
      connectionEpoch: entry.id ? (state.rootEpochs[entry.id] ?? 0) : 0,
    };
  });
  // Preserve both sides of an alias collision. F063 rejects ambiguous weak IDs;
  // a config connection must never silently disappear behind an env entry.
  return [...envRoots.map((entry) => ({ ...entry, removable: false })), ...configRoots];
}

/** Add a linked root to the config file. Validates path exists. */
export async function addLinkedRoot(name: string, rootPath: string): Promise<WorktreeEntry> {
  const resolved = await realpath(rootPath);
  // Validate path exists and is a directory
  const st = await stat(resolved).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new WorkspaceSecurityError(`Path is not a directory: ${resolved}`, 'NOT_FOUND');
  }

  return mutateLinkedRootState((state) => {
    const entry = toLinkedEntry(name, resolved);
    if (
      [...getLinkedRoots(), ...state.roots.map((row) => toLinkedEntry(row.name, row.path))].some(
        (row) => row.id === entry.id && row.root !== resolved,
      )
    )
      throw new WorkspaceSecurityError('This connection name belongs to another root', 'DENIED');
    const existing = findLinkedRootAt(state, resolved);
    const id = canonicalLinkedRootId(resolved);
    if (existing)
      return {
        value: {
          ...toLinkedEntry(existing.name, resolved),
          ...(existing.id ? { id: existing.id } : {}),
          ...(existing.legacyAliases ? { legacyAliases: existing.legacyAliases } : {}),
          removable: true,
        },
        changed: false,
      };
    state.roots.push({ id, name, path: resolved });
    state.rootEpochs[id] = (state.rootEpochs[id] ?? 0) + 1;
    return { value: { ...entry, id, removable: true }, changed: true };
  });
}

/** Remove a linked root from the config file by id. */
export async function removeLinkedRoot(linkedId: string, expectedEpoch?: number): Promise<boolean> {
  return mutateLinkedRootState((state) => {
    const matching = state.roots.filter(
      (row) =>
        row.id === linkedId ||
        row.legacyAliases?.includes(linkedId) ||
        (!row.id && toLinkedEntry(row.name, row.path).id === linkedId),
    );
    if (matching.length === 0) return { value: false, changed: false };
    if (matching.length > 1) throw new WorkspaceSecurityError('Connection identity is ambiguous', 'DENIED');
    const selected = matching[0]!;
    if (expectedEpoch !== undefined && (selected.id ? (state.rootEpochs[selected.id] ?? 0) : 0) !== expectedEpoch)
      throw new WorkspaceSecurityError('The connection changed after it was displayed', 'DENIED');
    state.roots = state.roots.filter((row) => row !== selected);
    const identities = new Set([selected.id ?? canonicalLinkedRootId(resolve(selected.path))]);
    if (!selected.id) {
      try {
        identities.add(canonicalLinkedRootId(realpathSync(selected.path)));
      } catch {
        /* Removal remains available for missing legacy roots. */
      }
    }
    for (const id of identities) state.rootEpochs[id] = (state.rootEpochs[id] ?? 0) + 1;
    return { value: true, changed: true };
  });
}
