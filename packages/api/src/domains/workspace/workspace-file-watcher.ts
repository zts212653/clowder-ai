import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Server, Socket } from 'socket.io';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { getWorktreeRoot, resolveWorkspacePath } from './workspace-security.js';

const log = createModuleLogger('file-watcher');
const DEBOUNCE_MS = 300;
const POLL_FALLBACK_MS = 150;

interface WatchEntry {
  stop: () => void;
  worktreeId: string;
  path: string;
  absolutePath: string;
  lastSha256: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function startFileMonitor(parentDir: string, onFsEvent: () => void, onPoll: () => void): () => void {
  let poller: ReturnType<typeof setInterval> | null = null;
  const startPolling = () => {
    if (poller) return;
    poller = setInterval(onPoll, POLL_FALLBACK_MS);
    poller.unref?.();
  };

  try {
    const watcher = watch(parentDir, { persistent: false }, onFsEvent);
    watcher.on('error', (err) => {
      log.warn({ parentDir, err }, 'fs.watch failed, falling back to polling');
      watcher.close();
      startPolling();
    });
    return () => {
      watcher.close();
      if (poller) clearInterval(poller);
    };
  } catch (err) {
    log.warn({ parentDir, err }, 'fs.watch unavailable, falling back to polling');
    startPolling();
    return () => {
      if (poller) clearInterval(poller);
    };
  }
}

async function computeFileSha256(absolutePath: string): Promise<string | null> {
  try {
    const content = await readFile(absolutePath, 'utf-8');
    return sha256(content);
  } catch {
    return null;
  }
}

export function setupWorkspaceFileWatcher(io: Server): void {
  const socketWatchers = new Map<string, WatchEntry>();

  io.on('connection', (socket: Socket) => {
    socket.on('workspace:watch-file', async (data: { worktreeId: string; path: string; sha256?: string }) => {
      if (!data?.worktreeId || !data?.path) return;

      cleanupSocket(socket.id);

      try {
        const root = await getWorktreeRoot(data.worktreeId);
        const absolutePath = await resolveWorkspacePath(root, data.path);
        await stat(absolutePath);

        const currentSha = (await computeFileSha256(absolutePath)) || '';
        const parentDir = dirname(absolutePath);

        const entry: WatchEntry = {
          stop: () => {},
          worktreeId: data.worktreeId,
          path: data.path,
          absolutePath,
          lastSha256: currentSha,
          debounceTimer: null,
        };

        const scheduleChange = () => {
          // Atomic-save flows can report only the temporary filename; the sha check below suppresses unrelated events.
          if (socketWatchers.get(socket.id) !== entry) return;
          if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
          entry.debounceTimer = setTimeout(() => handleChange(socket, entry), DEBOUNCE_MS);
        };

        const stop = startFileMonitor(parentDir, scheduleChange, () => {
          if (socketWatchers.get(socket.id) !== entry) return;
          void handleChange(socket, entry);
        });

        entry.stop = stop;
        socketWatchers.set(socket.id, entry);

        log.debug({ socketId: socket.id, path: data.path }, 'Watching file');

        if (currentSha && data.sha256 !== currentSha) {
          socket.emit('workspace:file-changed', {
            worktreeId: data.worktreeId,
            path: data.path,
            sha256: currentSha,
          });
          log.debug({ socketId: socket.id, path: data.path }, 'Immediate sha mismatch, notified client');
        }
      } catch (e) {
        log.debug({ socketId: socket.id, path: data.path, err: e }, 'Failed to watch file');
      }
    });

    socket.on('workspace:unwatch-file', () => {
      cleanupSocket(socket.id);
    });

    socket.on('disconnect', () => {
      cleanupSocket(socket.id);
    });
  });

  async function handleChange(socket: Socket, entry: WatchEntry): Promise<void> {
    const newSha = await computeFileSha256(entry.absolutePath);
    if (!newSha || newSha === entry.lastSha256) return;

    entry.lastSha256 = newSha;

    socket.emit('workspace:file-changed', {
      worktreeId: entry.worktreeId,
      path: entry.path,
      sha256: newSha,
    });
    log.debug({ socketId: socket.id, path: entry.path }, 'File changed, notified client');
  }

  function cleanupSocket(socketId: string): void {
    const entry = socketWatchers.get(socketId);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.stop();
    socketWatchers.delete(socketId);
  }
}
