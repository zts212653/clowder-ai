import { lstat, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { collectThreadMessageArtifacts } from '../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { TranscriptReader } from '../../cats/services/session/TranscriptReader.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { readGitWorktreeList } from '../../workspace/git-worktree-probe.js';

type Category =
  | 'transcript'
  | 'attachment'
  | 'work'
  | 'worktree'
  | 'git'
  | 'database'
  | 'native-session'
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
  threads: Pick<IThreadStore, 'list'>;
  messages: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
  sessions: Pick<ISessionChainStore, 'getChainByThread'>;
  transcriptReader?: Pick<TranscriptReader, 'readDigest'>;
  transcriptDir: string;
  uploadDir: string;
  connectorMediaDir: string;
  dataDir: string;
  logDir: string;
  nativeHomes: { codex: string; claude: string; dsh: string };
  tempDir: string;
}

export function createConversationStorageSourceReader(input: SourcesInput) {
  return async (signal: AbortSignal): Promise<ConversationStorageSources> => {
    const transcripts = join(input.transcriptDir, 'threads');
    const roots: StorageSource[] = [
      { path: transcripts, category: 'transcript', optional: true },
      { path: input.uploadDir, category: 'attachment', optional: true },
      { path: input.connectorMediaDir, category: 'attachment', optional: true },
      { path: join(input.dataDir, 'projects', 'content-owner-v1'), category: 'work', optional: true },
      { path: join(input.dataDir, 'collaborative-content'), category: 'database', optional: true },
      { path: join(input.dataDir, 'redis'), category: 'database', optional: true },
      { path: join(dirname(input.transcriptDir), 'redis'), category: 'database', optional: true },
      { path: input.logDir, category: 'log', optional: true },
    ];
    const files: StorageSource[] = [];
    const nativeSessions: ConversationStorageSources['nativeSessions'] = [];
    const omissions: ConversationStorageSources['omissions'] = [];
    const nativeRoots = new Set<string>();
    const gitRoots = new Map<string, Promise<string | null>>();
    const addNativeHome = (provider: keyof SourcesInput['nativeHomes'], path: string) => {
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

    addNativeHome('codex', input.nativeHomes.codex);
    addNativeHome('claude', input.nativeHomes.claude);
    addNativeHome('dsh', input.nativeHomes.dsh);

    const threads = await input.threads.list(input.ownerUserId, { signal });
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
        if (input.transcriptReader && session.status === 'sealed') {
          const digest = await input.transcriptReader.readDigest(session.id, threadId, session.catId);
          const touches = digestFiles.safeParse(digest?.filesTouched);
          if (touches.success) {
            for (const file of touches.data) {
              if (!file.ops.includes('create') && !file.ops.includes('edit')) continue;
              const path = fileUnderWorkspace(session.workingDirectory ?? thread.projectPath, file.path);
              if (path) files.push({ path, category: 'work', threadId });
            }
          }
        }
      }

      for (const path of thread.threadMetadata?.worktrees ?? []) await addWorktree(path, threadId);
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
  ],
  claude: [['projects', 'native-session']],
  dsh: [
    ['sessions', 'native-session'],
    ['attachments', 'attachment'],
    ['storages', 'database'],
    ['spill', 'temp'],
  ],
} as const;

function isNativeProvider(client: string): client is keyof typeof nativeLocations {
  return Object.hasOwn(nativeLocations, client);
}

function isDirectoryBelowRoot(path: string): boolean {
  return isAbsolute(path) && resolve(path) !== parse(resolve(path)).root && !path.startsWith('\\\\');
}

const digestFiles = z.array(z.object({ path: z.string(), ops: z.array(z.string()) }));

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
  };
}

export const conversationStorageTempDir = tmpdir;
