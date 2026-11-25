import { lstat, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { collectThreadMessageArtifacts } from '../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { TranscriptReader } from '../../cats/services/session/TranscriptReader.js';
import { materializeFilesTouched, recordFilesTouched } from '../../cats/services/session/transcript-file-touches.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { ProjectContentOwnerStore } from '../../video-studio/content-owner/store.js';
import { readGitWorktreeList } from '../../workspace/git-worktree-probe.js';

type Category =
  | 'transcript'
  | 'attachment'
  | 'work'
  | 'worktree'
  | 'git'
  | 'database'
  | 'native-session'
  | 'archive'
  | 'temp'
  | 'log';
interface StorageSource {
  path: string;
  category: Category;
  threadId?: string;
  optional?: boolean;
}

export interface ConversationStorageSources {
  threads: { id: string; title: string | null }[];
  roots: StorageSource[];
  files: StorageSource[];
  nativeSessions: { id: string; threadId: string }[];
  omissions: { path: string; reason: string; count: number }[];
}

interface SourcesInput {
  ownerUserId: string;
  threads: Pick<IThreadStore, 'list' | 'listDeleted'>;
  messages: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
  sessions: Pick<ISessionChainStore, 'getChainByThread'>;
  transcriptReader?: Pick<TranscriptReader, 'readDigest' | 'scanEvents' | 'getSessionDir'>;
  transcriptDir: string;
  uploadDir: string;
  connectorMediaDir: string;
  dataDir: string;
  workspaceRoot?: string;
  logDir: string;
  nativeHomes: Partial<Record<NativeProvider, string>>;
  nativeHistoryRoot?: string;
  databasePaths?: string[];
  cliArchiveDir?: string;
  tempDir: string;
}

export function createConversationStorageSourceReader(input: SourcesInput) {
  const workspaceData = input.workspaceRoot ? join(input.workspaceRoot, '.cat-cafe') : input.dataDir;
  const workData = [...new Set([input.dataDir, workspaceData].map((path) => resolve(path)))].map((path) => ({
    path: join(path, 'projects', 'content-owner-v1'),
    store: new ProjectContentOwnerStore(path),
  }));
  return async (signal: AbortSignal): Promise<ConversationStorageSources> => {
    const transcripts = join(input.transcriptDir, 'threads');
    const roots: StorageSource[] = [
      { path: transcripts, category: 'transcript', optional: true },
      { path: input.uploadDir, category: 'attachment', optional: true },
      { path: input.connectorMediaDir, category: 'attachment', optional: true },
      ...workData.map(({ path }) => ({ path, category: 'work' as const, optional: true })),
      { path: join(input.dataDir, 'collaborative-content'), category: 'database', optional: true },
      { path: join(input.dataDir, 'redis'), category: 'database', optional: true },
      { path: join(dirname(input.transcriptDir), 'redis'), category: 'database', optional: true },
      { path: input.logDir, category: 'log', optional: true },
      { path: join(input.dataDir, 'redis-backups'), category: 'archive', optional: true },
      { path: join(input.dataDir, 'native-sessions'), category: 'archive', optional: true },
    ];
    const files: StorageSource[] = [];
    for (const path of [
      ...(input.databasePaths ?? []),
      join(input.dataDir, 'listen-mode.sqlite'),
      join(input.dataDir, 'workspace', 'writebacks.sqlite'),
    ]) {
      if (!isAbsolute(path)) continue;
      for (const suffix of ['', '-wal', '-shm'])
        files.push({ path: path + suffix, category: 'database', optional: true });
    }
    if (input.cliArchiveDir) roots.push({ path: input.cliArchiveDir, category: 'archive', optional: true });
    const nativeSessions: ConversationStorageSources['nativeSessions'] = [];
    const omissions: ConversationStorageSources['omissions'] = [];
    const transcriptReader = input.transcriptReader;
    const nativeRoots = new Set<string>();
    const gitRoots = new Map<string, Promise<string | null>>();
    const addNativeHome = (provider: NativeProvider, path: string) => {
      if (!isDirectoryBelowRoot(path)) return;
      for (const [directory, category] of nativeLocations[provider]) {
        const fullPath = join(path, directory);
        if (nativeRoots.has(fullPath)) continue;
        nativeRoots.add(fullPath);
        roots.push({ path: fullPath, category, optional: true });
      }
    };

    async function addWorktree(path: string, threadId: string) {
      if (!isDirectoryBelowRoot(path)) return;
      const marker = await lstat(join(path, '.git')).catch(() => undefined);
      if (!marker || (!marker.isFile() && !marker.isDirectory())) {
        omissions.push({ path, reason: 'worktree-unavailable', count: 1 });
        return;
      }
      roots.push({ path, category: 'worktree', threadId });
      let git = gitRoots.get(path);
      if (!git) {
        git = readGitWorktreeList(path).catch(() => null);
        gitRoots.set(path, git);
      }
      const mainPath = (await git)
        ?.split(/\r?\n/)
        .find((line) => line.startsWith('worktree '))
        ?.slice(9);
      if (mainPath && isDirectoryBelowRoot(mainPath))
        roots.push({ path: join(mainPath, '.git', 'objects'), category: 'git', optional: true });
    }

    for (const provider of Object.keys(nativeLocations).filter(isNativeProvider)) {
      const home = input.nativeHomes[provider];
      if (home) addNativeHome(provider, home);
      if (input.nativeHistoryRoot) addNativeHome(provider, join(input.nativeHistoryRoot, provider));
    }
    const desktopDsh = join(workspaceData, 'dsh-desktop');
    const profiles = await readdir(desktopDsh, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') omissions.push({ path: desktopDsh, reason: 'unreadable', count: 1 });
      return [];
    });
    for (const profile of profiles.filter((entry) => entry.isDirectory())) {
      const home = join(desktopDsh, profile.name);
      for (const [directory, category] of nativeLocations.dsh.slice(0, 2))
        roots.push({ path: join(home, directory), category, optional: true });
    }

    const [active, retained] = await Promise.all([
      input.threads.list(input.ownerUserId, { signal }),
      input.threads.listDeleted(input.ownerUserId),
    ]);
    const threads = [...new Map([...active, ...retained].map((thread) => [thread.id, thread])).values()];
    for (const thread of threads) {
      signal.throwIfAborted();
      const threadId = thread.id;
      if (directoryName(threadId))
        roots.push({ path: join(transcripts, threadId), category: 'transcript', threadId, optional: true });

      const [sessions, artifacts] = await Promise.all([
        input.sessions.getChainByThread(threadId, { signal }),
        collectThreadMessageArtifacts(input.messages, threadId, input.ownerUserId, () => signal.throwIfAborted()),
      ]);
      for (const session of sessions) {
        if (session.userId !== input.ownerUserId) continue;
        if (session.cliSessionId) nativeSessions.push({ id: session.cliSessionId, threadId });
        const native = session.hostExecutionBoundary;
        if (native?.accountStateRoot && isNativeProvider(native.clientId))
          addNativeHome(native.clientId, native.accountStateRoot);
        if (transcriptReader) {
          const touches = await readSessionFileTouches(transcriptReader, session, threadId, signal).catch(() => {
            signal.throwIfAborted();
            omissions.push({
              path: transcriptReader.getSessionDir(threadId, session.catId, session.id),
              reason: 'transcript-unavailable',
              count: 1,
            });
            return [];
          });
          for (const file of touches) {
            if (!file.ops.includes('create') && !file.ops.includes('edit')) continue;
            const path = fileUnderWorkspace(session.workingDirectory ?? thread.projectPath, file.path);
            if (path) files.push({ path, category: 'work', threadId });
          }
        }
      }

      for (const path of thread.threadMetadata?.worktrees ?? []) await addWorktree(path, threadId);
      for (const work of workData) {
        try {
          for await (const path of work.store.retainedThreadStorageDirectories(input.ownerUserId, threadId)) {
            signal.throwIfAborted();
            roots.push({ path, category: 'work', threadId });
          }
        } catch {
          signal.throwIfAborted();
          omissions.push({ path: work.path, reason: 'work-attribution-unavailable', count: 1 });
        }
      }
      for (const artifact of artifacts) {
        const path = localAttachment(artifact.url, input);
        if (path) files.push({ path, category: 'attachment', threadId });
      }
      for (const entry of thread.threadMemory?.recentArtifacts ?? []) {
        if (entry.type !== 'file') continue;
        const path = fileUnderWorkspace(thread.projectPath, entry.ref);
        if (path) files.push({ path, category: 'work', threadId });
      }
    }

    const tempEntries = await readdir(input.tempDir, { withFileTypes: true }).catch(() => {
      omissions.push({ path: input.tempDir, reason: 'temp-directory-unavailable', count: 1 });
      return [];
    });
    for (const entry of tempEntries) {
      if (entry.name.startsWith('dsh-workspace-changes-') || entry.name.startsWith('dsh-spill-'))
        roots.push({ path: join(input.tempDir, entry.name), category: 'temp' });
    }
    return { threads: threads.map(({ id, title }) => ({ id, title })), roots, files, nativeSessions, omissions };
  };
}

const nativeLocations = {
  codex: [
    ['sessions', 'native-session'],
    ['archived_sessions', 'native-session'],
    ['generated_images', 'attachment'],
    ['attachments', 'attachment'],
  ],
  claude: [
    ['projects', 'native-session'],
    ['file-history', 'native-session'],
  ],
  dsh: [
    ['sessions', 'native-session'],
    ['attachments', 'attachment'],
    ['storages', 'database'],
    ['spill', 'temp'],
  ],
  kimi: [
    ['sessions', 'native-session'],
    ['file-history', 'native-session'],
  ],
  pi: [['sessions', 'native-session']],
  gemini: [['.gemini/antigravity/conversations', 'native-session']],
} as const;

type NativeProvider = keyof typeof nativeLocations;

function isNativeProvider(client: string): client is NativeProvider {
  return Object.hasOwn(nativeLocations, client);
}

function isDirectoryBelowRoot(path: string): boolean {
  return isAbsolute(path) && resolve(path) !== parse(resolve(path)).root && !path.startsWith('\\\\');
}

const digestFiles = z.array(z.object({ path: z.string(), ops: z.array(z.string()) }));

async function readSessionFileTouches(
  reader: NonNullable<SourcesInput['transcriptReader']>,
  session: { id: string; catId: string; status: string },
  threadId: string,
  signal: AbortSignal,
) {
  if (session.status === 'sealed') {
    const digest = await reader.readDigest(session.id, threadId, session.catId);
    const touches = digestFiles.safeParse(digest?.filesTouched);
    if (touches.success) return touches.data;
  }
  const paths = new Map<string, Set<string>>();
  await reader.scanEvents(
    session.id,
    threadId,
    session.catId,
    ({ event }) => {
      const name = event.toolName ?? event.name;
      if (typeof name === 'string') recordFilesTouched(paths, event, name);
    },
    signal,
    true,
  );
  return materializeFilesTouched(paths);
}

function fileUnderWorkspace(root: string, file: string) {
  if (!isDirectoryBelowRoot(root)) return undefined;
  const path = resolve(root, file);
  const rel = relative(root, path);
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) ? path : undefined;
}

function directoryName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\\/:\0]/.test(name);
}

function localAttachment(url: string | undefined, input: SourcesInput): string | undefined {
  if (!url) return undefined;
  const prefix = url.startsWith('/uploads/')
    ? '/uploads/'
    : url.startsWith('/api/connector-media/')
      ? '/api/connector-media/'
      : undefined;
  if (!prefix) return undefined;
  const root = prefix === '/uploads/' ? input.uploadDir : input.connectorMediaDir;
  try {
    const name = decodeURIComponent(url.slice(prefix.length));
    return directoryName(name) ? join(root, name) : undefined;
  } catch {
    return undefined;
  }
}

export function configuredNativeStorageHomes() {
  return {
    codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
    claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    dsh: process.env.DSH_HOME || join(homedir(), '.dsh'),
    kimi: process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'),
    pi: process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
    gemini: process.env.GEMINI_CLI_HOME || homedir(),
  };
}

export const conversationStorageTempDir = tmpdir;
