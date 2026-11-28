import { isDeepStrictEqual } from 'node:util';
import type {
  AgentAccessCodexAppServerThreadRequest,
  AgentAccessCodexAppServerTurnRequest,
} from '@clowder-ai/agent-contract';
import type { CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';

type JsonObject = CodexAppServerJsonObject;
type RefValue = string | JsonObject | readonly unknown[];
type GroupRefs = Map<string, RefValue>;

export interface CodexAppServerThreadSource {
  kind: 'start' | 'resume';
  threadId?: string;
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  developerInstructions?: string;
  config?: JsonObject;
  serviceTier?: string | null;
  approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent';
}

export interface CodexAppServerTurnSource {
  threadId: string;
  clientUserMessageId?: string;
  prompt?: string;
  imagePaths?: readonly string[];
  recoveryContext?: string;
  outputSchema?: JsonObject;
  collaborationMode?: JsonObject;
}

export type CodexAppServerThreadPlanner = (
  request: AgentAccessCodexAppServerThreadRequest,
) => Promise<{ params: JsonObject; startParams?: JsonObject; assertCurrent?: () => Promise<void> }>;
export type CodexAppServerTurnPlanner = (
  request: AgentAccessCodexAppServerTurnRequest,
) => Promise<{ params: JsonObject; assertCurrent?: () => Promise<void> }>;

const TOKEN_PREFIX = '__CAT_CAFE_CODEX_AS_';

function addRef(refs: GroupRefs, role: string, value: RefValue): string {
  const token = `${TOKEN_PREFIX}${role}_${refs.size}__`;
  refs.set(token, value);
  return token;
}

function buildThreadRequest(source: CodexAppServerThreadSource): {
  request: AgentAccessCodexAppServerThreadRequest;
  refs: GroupRefs;
} {
  const refs: GroupRefs = new Map();
  const groups: AgentAccessCodexAppServerThreadRequest['groups'] = {};
  if (source.kind === 'resume' && source.threadId) groups.threadId = addRef(refs, 'threadId', source.threadId);
  if (source.model) groups.model = addRef(refs, 'model', source.model);
  if (source.cwd) groups.cwd = addRef(refs, 'cwd', source.cwd);
  if (source.developerInstructions)
    groups.developerInstructions = addRef(refs, 'developerInstructions', source.developerInstructions);
  if (source.config) groups.config = addRef(refs, 'config', source.config);
  return {
    request: {
      operation: 'plan_app_server_thread',
      client: 'codex',
      kind: source.kind,
      groups,
      options: {
        ...(source.sandbox ? { sandbox: source.sandbox } : {}),
        ...(source.approvalPolicy ? { approvalPolicy: source.approvalPolicy } : {}),
        ...(Object.hasOwn(source, 'serviceTier') ? { serviceTier: source.serviceTier ?? null } : {}),
        ...(source.approvalsReviewer ? { approvalsReviewer: source.approvalsReviewer } : {}),
      },
    },
    refs,
  };
}

function buildTurnRequest(source: CodexAppServerTurnSource): {
  request: AgentAccessCodexAppServerTurnRequest;
  refs: GroupRefs;
} {
  const refs: GroupRefs = new Map();
  const groups: AgentAccessCodexAppServerTurnRequest['groups'] = {
    threadId: addRef(refs, 'threadId', source.threadId),
  };
  if (source.clientUserMessageId)
    groups.clientUserMessageId = addRef(refs, 'clientUserMessageId', source.clientUserMessageId);
  if (source.prompt !== undefined) groups.prompt = addRef(refs, 'prompt', source.prompt);
  if (source.imagePaths && source.imagePaths.length > 0)
    groups.images = source.imagePaths.map((path) => addRef(refs, 'image', path));
  if (source.recoveryContext) groups.recoveryContext = addRef(refs, 'recoveryContext', source.recoveryContext);
  if (source.outputSchema) groups.outputSchema = addRef(refs, 'outputSchema', source.outputSchema);
  if (source.collaborationMode) groups.collaborationMode = addRef(refs, 'collaborationMode', source.collaborationMode);
  return {
    request: { operation: 'plan_app_server_turn', client: 'codex', groups },
    refs,
  };
}

function fail(): never {
  throw Object.assign(new Error('codex_app_server_plan_policy_violation'), {
    code: 'CODEX_APP_SERVER_PLAN_POLICY_VIOLATION',
  });
}

function expand(value: unknown, refs: GroupRefs): unknown {
  if (typeof value === 'string') {
    if (value.startsWith(TOKEN_PREFIX)) {
      if (!refs.has(value)) fail();
      return refs.get(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => [key, expand(item, refs)]));
  }
  return value;
}

function tokenAt(params: JsonObject, key: string, token: string | undefined): void {
  if (token) {
    if (params[key] !== token) fail();
  } else if (Object.hasOwn(params, key)) {
    fail();
  }
}

function assertTopLevelKeys(params: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(params)) if (!allowedSet.has(key)) fail();
}

function assertThreadParams(
  params: JsonObject,
  request: AgentAccessCodexAppServerThreadRequest,
  options: { resumeStart: boolean },
): void {
  assertTopLevelKeys(params, [
    'threadId',
    'excludeTurns',
    'sandbox',
    'approvalPolicy',
    'model',
    'cwd',
    'developerInstructions',
    'config',
    'serviceTier',
    'approvalsReviewer',
  ]);
  const { groups, options: safe } = request;
  if (options.resumeStart) {
    if (Object.hasOwn(params, 'threadId') || Object.hasOwn(params, 'excludeTurns')) fail();
  } else {
    tokenAt(params, 'threadId', groups.threadId);
    if (groups.threadId) {
      if (params.excludeTurns !== true) fail();
    } else if (Object.hasOwn(params, 'excludeTurns')) fail();
  }
  tokenAt(params, 'model', groups.model);
  tokenAt(params, 'cwd', groups.cwd);
  tokenAt(params, 'developerInstructions', groups.developerInstructions);
  tokenAt(params, 'config', groups.config);
  if (safe.sandbox) {
    if (params.sandbox !== safe.sandbox) fail();
  } else if (Object.hasOwn(params, 'sandbox')) fail();
  if (safe.approvalPolicy) {
    if (params.approvalPolicy !== safe.approvalPolicy) fail();
  } else if (Object.hasOwn(params, 'approvalPolicy')) fail();
  if (Object.hasOwn(safe, 'serviceTier')) {
    if (params.serviceTier !== (safe.serviceTier ?? null)) fail();
  } else if (Object.hasOwn(params, 'serviceTier')) fail();
  if (safe.approvalsReviewer) {
    if (params.approvalsReviewer !== safe.approvalsReviewer) fail();
  } else if (Object.hasOwn(params, 'approvalsReviewer')) fail();
}

export async function planCodexAppServerThread(
  source: CodexAppServerThreadSource,
  planner: CodexAppServerThreadPlanner | undefined,
): Promise<{ params: JsonObject; startParams?: JsonObject; assertCurrent?: () => Promise<void> } | undefined> {
  if (!planner) return undefined;
  const { request, refs } = buildThreadRequest(source);
  const plan = await planner(request);
  assertThreadParams(plan.params, request, { resumeStart: false });
  if (request.kind === 'start') {
    if (plan.startParams) fail();
  } else {
    if (!plan.startParams) fail();
    assertThreadParams(plan.startParams, request, { resumeStart: true });
  }

  return {
    params: expand(plan.params, refs) as JsonObject,
    ...(plan.startParams ? { startParams: expand(plan.startParams, refs) as JsonObject } : {}),
    ...(plan.assertCurrent ? { assertCurrent: plan.assertCurrent } : {}),
  };
}

export async function planCodexAppServerTurn(
  source: CodexAppServerTurnSource,
  planner: CodexAppServerTurnPlanner | undefined,
): Promise<{ params: JsonObject; assertCurrent?: () => Promise<void> } | undefined> {
  if (!planner) return undefined;
  const { request, refs } = buildTurnRequest(source);
  const plan = await planner(request);
  const params = plan.params;
  assertTopLevelKeys(params, [
    'threadId',
    'clientUserMessageId',
    'input',
    'additionalContext',
    'outputSchema',
    'collaborationMode',
  ]);
  const { groups } = request;
  tokenAt(params, 'threadId', groups.threadId);
  tokenAt(params, 'clientUserMessageId', groups.clientUserMessageId);
  tokenAt(params, 'outputSchema', groups.outputSchema);
  tokenAt(params, 'collaborationMode', groups.collaborationMode);
  const expectedInput = [
    ...(groups.prompt ? [{ type: 'text', text: groups.prompt }] : []),
    ...(groups.images?.map((path) => ({ type: 'localImage', path })) ?? []),
  ];
  if (!isDeepStrictEqual(params.input, expectedInput)) fail();
  if (groups.recoveryContext) {
    const expectedContext = { 'cat-cafe.capacity-recovery': { kind: 'application', value: groups.recoveryContext } };
    if (!isDeepStrictEqual(params.additionalContext, expectedContext)) fail();
  } else if (Object.hasOwn(params, 'additionalContext')) fail();

  return {
    params: expand(params, refs) as JsonObject,
    ...(plan.assertCurrent ? { assertCurrent: plan.assertCurrent } : {}),
  };
}
