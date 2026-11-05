import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Server, Socket } from 'socket.io';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { computeWorkspaceFileSha256 } from './workspace-file-read.js';
import { getWorktreeRoot, resolveWorkspaceFilesystemPath } from './workspace-security.js';

const log = createModuleLogger('file-watcher');
const DEBOUNCE_MS = 300;
const POLL_FALLBACK_MS = 150;
const WATCHDOG_POLL_MS = 1000;

interface WatchEntry {
  stop: () => void;
  worktreeId: string;
  path: string;
  absolutePath: string;
  lastSha256: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

function startFileMonitor(parentDir: string, onFsEvent: () => void, onPoll: () => void): () => void {
  let poller: ReturnType<typeof setInterval> | null = null;
  const startPolling = (intervalMs: number) => {
    if (poller) return;
    poller = setInterval(onPoll, intervalMs);
    poller.unref?.();
  };

  try {
    const watcher = watch(parentDir, { persistent: false }, onFsEvent);
    // fs.watch can silently miss atomic-save events under load; a low-frequency sha poll keeps the watcher live.
    startPolling(WATCHDOG_POLL_MS);
    watcher.on('error', (err) => {
      log.warn({ parentDir, err }, 'fs.watch failed, falling back to polling');
      watcher.close();
    });
    return () => {
      watcher.close();
      if (poller) clearInterval(poller);
    };
  } catch (err) {
    log.warn({ parentDir, err }, 'fs.watch unavailable, falling back to polling');
    startPolling(POLL_FALLBACK_MS);
    return () => {
      if (poller) clearInterval(poller);
    };
  }
}

/**
 * One watch slot on a socket. A slot is registered before the file is resolved, so
 * a release while it is still being established (unwatch, disconnect, or a newer
 * watch on the same slot) is visible to the pending establishment, which then
 * starts nothing. `entry` is set only once the file monitor runs.
 */
interface WatchRegistration {
  /** null for the original protocol, whose pages send no watchId. */
  readonly watchId: string | null;
  entry: WatchEntry | null;
}

interface WatchFileRequest {
  watchId?: unknown;
  worktreeId?: string;
  path?: string;
  sha256?: string | null;
}

/**
 * Pages loaded before watchId existed share this one slot per socket. A symbol, so no
 * client-supplied watchId can name it.
 */
const LEGACY_SLOT: unique symbol = Symbol('legacy-watch-slot');
type WatchSlot = string | typeof LEGACY_SLOT;
const MAX_WATCH_ID_LENGTH = 128;

/** Slot for a watchId as sent by the client; undefined when the id is malformed. */
function slotFor(watchId: unknown): WatchSlot | undefined {
  if (watchId === undefined || watchId === null) return LEGACY_SLOT;
  if (typeof watchId !== 'string' || watchId.length === 0 || watchId.length > MAX_WATCH_ID_LENGTH) return undefined;
  return watchId;
}

async function resolveWatchTarget(worktreeId: string, path: string): Promise<{ absolutePath: string; sha256: string }> {
  const root = await getWorktreeRoot(worktreeId);
  const absolutePath = await resolveWorkspaceFilesystemPath(root, path);
  await stat(absolutePath);
  return { absolutePath, sha256: (await computeWorkspaceFileSha256(absolutePath)) || '' };
}

export interface WorkspaceFileWatcherInspection {
  /** Watches with a running file monitor. */
  watches: number;
  /** Watches still resolving their file. */
  pending: number;
}

export function setupWorkspaceFileWatcher(io: Server): { inspect: () => WorkspaceFileWatcherInspection } {
  const socketWatches = new Map<string, Map<WatchSlot, WatchRegistration>>();

  const isCurrent = (socketId: string, slot: WatchSlot, registration: WatchRegistration) =>
    socketWatches.get(socketId)?.get(slot) === registration;

  io.on('connection', (socket: Socket) => {
    socket.on('workspace:watch-file', (data: WatchFileRequest) => {
      void watchFile(socket, data);
    });

    // The original protocol sends no payload and owns only the legacy slot, so an
    // old page's unwatch cannot release the watches a current page holds.
    socket.on('workspace:unwatch-file', (data?: { watchId?: unknown }) => {
      const slot = slotFor(data?.watchId);
      if (slot !== undefined) release(socket.id, slot);
    });

    socket.on('disconnect', () => {
      const slots = socketWatches.get(socket.id);
      if (!slots) return;
      for (const slot of [...slots.keys()]) release(socket.id, slot);
      socketWatches.delete(socket.id);
    });
  });

  async function watchFile(socket: Socket, data: WatchFileRequest): Promise<void> {
    if (!data?.worktreeId || !data?.path) return;
    const slot = slotFor(data.watchId);
    if (slot === undefined) return;
    const { worktreeId, path } = data;
    const registration = claimSlot(socket.id, slot);

    try {
      const { absolutePath, sha256 } = await resolveWatchTarget(worktreeId, path);
      // Released, superseded or disconnected while the file was being resolved.
      if (!isCurrent(socket.id, slot, registration)) return;
      const entry: WatchEntry = {
        stop: () => {},
        worktreeId,
        path,
        absolutePath,
        lastSha256: sha256,
        debounceTimer: null,
      };
      startWatch(socket, slot, registration, entry);
      log.debug({ socketId: socket.id, watchId: registration.watchId, path }, 'Watching file');

      if (sha256 && data.sha256 !== sha256) {
        emitChange(socket, registration, entry, sha256);
        log.debug({ socketId: socket.id, path }, 'Immediate sha mismatch, notified client');
      }
    } catch (e) {
      if (isCurrent(socket.id, slot, registration)) socketWatches.get(socket.id)?.delete(slot);
      log.debug({ socketId: socket.id, path, err: e }, 'Failed to watch file');
    }
  }

  /** Replaces whatever the slot held with a pending registration, before any file I/O. */
  function claimSlot(socketId: string, slot: WatchSlot): WatchRegistration {
    release(socketId, slot);
    const registration: WatchRegistration = { watchId: slot === LEGACY_SLOT ? null : slot, entry: null };
    let slots = socketWatches.get(socketId);
    if (!slots) {
      slots = new Map();
      socketWatches.set(socketId, slots);
    }
    slots.set(slot, registration);
    return registration;
  }

  function startWatch(socket: Socket, slot: WatchSlot, registration: WatchRegistration, entry: WatchEntry): void {
    const active = () => registration.entry === entry && isCurrent(socket.id, slot, registration);
    const scheduleChange = () => {
      // Atomic-save flows can report only the temporary filename; the sha check below suppresses unrelated events.
      if (!active()) return;
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        if (active()) void handleChange(socket, registration, entry);
      }, DEBOUNCE_MS);
    };
    entry.stop = startFileMonitor(dirname(entry.absolutePath), scheduleChange, () => {
      if (active()) void handleChange(socket, registration, entry);
    });
    registration.entry = entry;
  }

  async function handleChange(socket: Socket, registration: WatchRegistration, entry: WatchEntry): Promise<void> {
    const newSha = await computeWorkspaceFileSha256(entry.absolutePath);
    if (!newSha || newSha === entry.lastSha256 || registration.entry !== entry) return;

    entry.lastSha256 = newSha;
    emitChange(socket, registration, entry, newSha);
    log.debug({ socketId: socket.id, path: entry.path }, 'File changed, notified client');
  }

  function emitChange(socket: Socket, registration: WatchRegistration, entry: WatchEntry, sha256: string): void {
    socket.emit('workspace:file-changed', {
      ...(registration.watchId === null ? {} : { watchId: registration.watchId }),
      worktreeId: entry.worktreeId,
      path: entry.path,
      sha256,
    });
  }

  function release(socketId: string, slot: WatchSlot): void {
    const slots = socketWatches.get(socketId);
    const registration = slots?.get(slot);
    if (!slots || !registration) return;
    slots.delete(slot);
    const { entry } = registration;
    registration.entry = null;
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.stop();
  }

  return {
    inspect: () => {
      let watches = 0;
      let pending = 0;
      for (const slots of socketWatches.values()) {
        for (const registration of slots.values()) {
          if (registration.entry) watches += 1;
          else pending += 1;
        }
      }
      return { watches, pending };
    },
  };
}
