import { humanSessionFirstLine, isCatCafeSessionInput, LOCAL_SESSION_CANDIDATE_LIMIT } from '@cat-cafe/shared';
import { CodexActiveWriterRecoveryError } from '../../runtime-session/CodexSessionReplacementProvenance.js';
import type { LocalSessionList, LocalSessionMetadata } from '../../types.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';
import type { CodexAppServerNativeRpcClient } from './CodexAppServerNativeRpc.js';
import { resolveCodexAppServerThread } from './CodexAppServerThreadResolver.js';

const INDEX_PAGE_SIZE = 50;
const MAX_INDEX_PAGES = 4;

export async function listCodexImportSessions(
  client: CodexAppServerNativeRpcClient,
  limit: number,
): Promise<LocalSessionList> {
  if (!Number.isInteger(limit) || limit < 1 || limit > LOCAL_SESSION_CANDIDATE_LIMIT)
    throw new Error('Invalid recent-session limit');
  // Read interactive sources separately: newer Cafe exec/Desktop carriers must
  // not consume the CLI page. Headless exec sessions remain importable by ID.
  async function readPage(source: 'cli' | 'vscode', pageSize: number, cursor?: string) {
    const response = asCodexAppServerRecord(
      await client.request('thread/list', {
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
        useStateDbOnly: true,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: [source],
      }),
    );
    if (!Array.isArray(response?.data)) throw new Error('Native session index is unavailable');
    const sessions: LocalSessionMetadata[] = [];
    for (const raw of response.data.slice(0, pageSize)) {
      // Local app-server rejects originators filters. Cafe and Desktop both
      // report vscode; use indexed originator without opening the rollout.
      const thread = asCodexAppServerRecord(raw);
      if (
        thread?.originator === 'cat-cafe' ||
        (typeof thread?.preview === 'string' && isCatCafeSessionInput(thread.preview))
      )
        continue;
      try {
        sessions.push(projectCodexLocalSession(raw));
      } catch {
        // A stale/invalid index row cannot expand the read into a transcript.
      }
    }
    return {
      sessions,
      cursor: typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined,
    };
  }

  const cli = await readPage('cli', Math.min(limit, INDEX_PAGE_SIZE));
  const sessions = new Map(cli.sessions.map((session) => [session.sessionId, session]));
  const desktopIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INDEX_PAGES; page++) {
    const desktop = await readPage('vscode', INDEX_PAGE_SIZE, cursor);
    for (const session of desktop.sessions) {
      desktopIds.add(session.sessionId);
      const previous = sessions.get(session.sessionId);
      if (!previous || previous.lastActivityAt < session.lastActivityAt) sessions.set(session.sessionId, session);
    }
    cursor = desktop.cursor;
    if (desktopIds.size >= limit || !cursor) break;
  }
  return {
    sessions: [...sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, limit),
    limited: Boolean(cli.cursor || cursor) || sessions.size > limit,
  };
}

export function projectCodexLocalSession(raw: unknown): LocalSessionMetadata {
  const thread = asCodexAppServerRecord(raw);
  if (typeof thread?.id !== 'string' || typeof thread.cwd !== 'string' || !thread.cwd.startsWith('/')) {
    throw Object.assign(new Error('The native session metadata is unavailable'), {
      code: 'SESSION_METADATA_UNAVAILABLE',
    });
  }
  return {
    sessionId: thread.id,
    clientId: 'openai',
    firstPrompt: typeof thread.preview === 'string' ? humanSessionFirstLine(thread.preview) : '',
    projectPath: thread.cwd,
    lastActivityAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : 0,
    turnCount: null,
  };
}

export async function inspectCodexImportSession(
  client: CodexAppServerNativeRpcClient,
  sessionId: string,
): Promise<LocalSessionMetadata> {
  const raw = asCodexAppServerRecord(await client.request('thread/read', { threadId: sessionId, includeTurns: false }));
  const metadata = projectCodexLocalSession(raw?.thread);
  if (metadata.sessionId !== sessionId) throw new Error('Native session read returned a different ID');
  try {
    const verdict = await resolveCodexAppServerThread({
      thread: { kind: 'resume', threadId: sessionId },
      params: { threadId: sessionId, excludeTurns: true },
      requireExactResume: true,
      localLiveLease: false,
      request: (method, params) =>
        client.request(method, method === 'thread/read' ? { ...params, includeTurns: false } : params),
      now: Date.now,
    });
    if (verdict.kind !== 'resumed') throw new Error('The original native session could not be resumed');
    return metadata;
  } catch (error) {
    if (error instanceof CodexActiveWriterRecoveryError) {
      throw Object.assign(error, { code: 'SESSION_ACTIVE_WRITER' });
    }
    throw error;
  }
}
