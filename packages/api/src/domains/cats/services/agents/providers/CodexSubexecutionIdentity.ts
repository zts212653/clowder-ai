import { asCodexAppServerRecord, type CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';

type JsonObject = CodexAppServerJsonObject;

export interface CodexSubexecutionIdentity {
  readonly activityId: string;
  readonly subexecutionId: string;
  readonly rootExecutionId: string;
  readonly parentExecutionId: string;
  readonly rootTurnId: string;
  readonly parentTurnId: string;
  readonly agentPath: string;
  readonly nickname?: string;
  readonly depth: number;
  activeTurnId: string | null;
}

export interface CodexSubexecutionEvent extends JsonObject {
  readonly type: 'app_server.subexecution';
  readonly event_id: string;
  readonly occurred_at: number;
  readonly stage: 'started' | 'message' | 'completed' | 'failed' | 'interrupted';
  readonly subexecution_id: string;
  readonly root_execution_id: string;
  readonly parent_execution_id: string;
  readonly root_turn_id: string;
  readonly parent_turn_id: string;
  readonly turn_id?: string;
  readonly agent_path: string;
  readonly nickname?: string;
  readonly depth: number;
  readonly content?: string;
  readonly message_phase?: 'commentary' | 'final_answer' | 'unknown';
}

interface RegistrationInput {
  readonly activity: JsonObject;
  readonly parent: CodexSubexecutionIdentity;
  readonly params: JsonObject;
  readonly readThread: (threadId: string) => Promise<unknown>;
}

const THREAD_IDENTITY_HYDRATION_TIMEOUT_MS = 250;

export async function createCodexSubexecutionIdentity(
  input: RegistrationInput,
): Promise<CodexSubexecutionIdentity | null> {
  const activityId = exactCodexCoordinate(input.activity.id);
  const subexecutionId = exactCodexCoordinate(input.activity.agentThreadId);
  const agentPath = exactAgentPath(input.activity.agentPath);
  const parentTurnId = exactCodexCoordinate(input.params.turnId);
  if (!activityId || !subexecutionId || !agentPath || !parentTurnId) return null;
  if (subexecutionId === input.parent.subexecutionId) return null;

  const fallbackDepth = depthFromAgentPath(agentPath);
  if (!fallbackDepth) return null;
  const hydrated = await readHydratedIdentity(input.readThread, subexecutionId, input.parent, agentPath);
  return {
    activityId,
    subexecutionId,
    rootExecutionId: input.parent.rootExecutionId,
    parentExecutionId: input.parent.subexecutionId,
    rootTurnId: input.parent.rootTurnId,
    parentTurnId,
    agentPath,
    ...(hydrated?.nickname ? { nickname: hydrated.nickname } : {}),
    depth: hydrated?.depth ?? fallbackDepth,
    activeTurnId: null,
  };
}

export function createCodexSubexecutionEvent(
  identity: CodexSubexecutionIdentity,
  input: {
    readonly eventId: string;
    readonly occurredAt: number;
    readonly stage: CodexSubexecutionEvent['stage'];
    readonly turnId?: string;
    readonly content?: string;
    readonly messagePhase?: CodexSubexecutionEvent['message_phase'];
  },
): CodexSubexecutionEvent {
  return {
    type: 'app_server.subexecution',
    event_id: input.eventId,
    occurred_at: input.occurredAt,
    stage: input.stage,
    subexecution_id: identity.subexecutionId,
    root_execution_id: identity.rootExecutionId,
    parent_execution_id: identity.parentExecutionId,
    root_turn_id: identity.rootTurnId,
    parent_turn_id: identity.parentTurnId,
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    agent_path: identity.agentPath,
    ...(identity.nickname ? { nickname: identity.nickname } : {}),
    depth: identity.depth,
    ...(input.content ? { content: input.content } : {}),
    ...(input.messagePhase ? { message_phase: input.messagePhase } : {}),
  };
}

async function readHydratedIdentity(
  readThread: (threadId: string) => Promise<unknown>,
  threadId: string,
  parent: CodexSubexecutionIdentity,
  agentPath: string,
): Promise<{ nickname?: string; depth: number } | null> {
  const result = asCodexAppServerRecord(await readThreadBounded(readThread, threadId));
  const thread = asCodexAppServerRecord(result?.thread);
  if (thread?.id !== threadId) return null;
  const source = asCodexAppServerRecord(thread.source);
  const subAgent = asCodexAppServerRecord(source?.subAgent);
  const spawn = asCodexAppServerRecord(subAgent?.thread_spawn);
  if (!matchesHydratedParent(thread, spawn, parent.subexecutionId)) return null;
  const hydratedPath = spawn?.agent_path == null ? agentPath : exactAgentPath(spawn.agent_path);
  if (hydratedPath !== agentPath) return null;
  const expectedDepth = depthFromAgentPath(agentPath);
  if (!expectedDepth || spawn?.depth !== expectedDepth) return null;
  const nickname = matchingNickname(spawn.agent_nickname, thread.agentNickname);
  return { ...(nickname ? { nickname } : {}), depth: expectedDepth };
}

function matchesHydratedParent(thread: JsonObject, spawn: JsonObject | null, parentId: string): boolean {
  const sourceParent = exactCodexCoordinate(spawn?.parent_thread_id);
  const threadParent = exactCodexCoordinate(thread.parentThreadId);
  return (
    (sourceParent === null || sourceParent === parentId) &&
    (threadParent === null || threadParent === parentId) &&
    (sourceParent !== null || threadParent !== null)
  );
}

async function readThreadBounded(
  readThread: (threadId: string) => Promise<unknown>,
  threadId: string,
): Promise<unknown | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const read = readThread(threadId).catch(() => null);
  const expired = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), THREAD_IDENTITY_HYDRATION_TIMEOUT_MS);
  });
  const result = await Promise.race([read, expired]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function matchingNickname(sourceValue: unknown, threadValue: unknown): string | null {
  const source = exactDisplayName(sourceValue);
  const thread = exactDisplayName(threadValue);
  if (source && thread && source !== thread) return null;
  return source ?? thread;
}

export function exactCodexCoordinate(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= 512 ? value : null;
}

function exactAgentPath(value: unknown): string | null {
  const path = exactCodexCoordinate(value);
  return path?.startsWith('/root/') ? path : null;
}

function exactDisplayName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= 160 ? value : null;
}

function depthFromAgentPath(path: string): number | null {
  const parts = path.split('/').filter(Boolean);
  return parts[0] === 'root' && parts.length > 1 && parts.length <= 33 ? parts.length - 1 : null;
}
