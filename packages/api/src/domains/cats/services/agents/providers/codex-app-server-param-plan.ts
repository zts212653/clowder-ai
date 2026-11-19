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
  if (source.developerInstructions) groups.developerInstructions = addRef(refs, 'developerInstructions', source.developerInstructions);
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
  if (source.clientUserMessageId) groups.clientUserMessageId = addRef(refs, 'clientUserMessageId', source.clientUserMessageId);
  if (source.prompt) groups.prompt = addRef(refs, 'prompt', source.prompt);
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

function assertNoUnknownTokens(value: unknown, refs: GroupRefs): void {
  if (typeof value === 'string') {
    if (value.startsWith(TOKEN_PREFIX) && !refs.has(value)) fail();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoUnknownTokens(item, refs);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as JsonObject)) assertNoUnknownTokens(item, refs);
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
  assertNoUnknownTokens(plan.params, refs);
  assertThreadParams(plan.params, request, { resumeStart: false });
  if (request.kind === 'start') {
    if (plan.startParams) fail();
  } else {
    if (!plan.startParams) fail();
    assertNoUnknownTokens(plan.startParams, refs);
    assertThreadParams(plan.startParams, request, { resumeStart: true });
  }
  const used = new Set<string>();
  const mark = (value: unknown): void => {
    if (typeof value === 'string') {
      if (refs.has(value)) used.add(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(mark);
    if (value && typeof value === 'object') Object.values(value as JsonObject).forEach(mark);
  };
  mark(plan.params);
  mark(plan.startParams);
  for (const token of refs.keys()) if (!used.has(token)) fail();

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
  assertNoUnknownTokens(params, refs);
  assertTopLevelKeys(params, ['threadId', 'clientUserMessageId', 'input', 'additionalContext', 'outputSchema', 'collaborationMode']);
  tokenAt(params, 'threadId', groupsThreadId(request));
  tokenAt(params, 'clientUserMessageId', request.groups.clientUserMessageId);
  if (request.groups.outputSchema) tokenAt(params, 'outputSchema', request.groups.outputSchema);
  else if (Object.hasOwn(params, 'outputSchema')) fail();
  if (request.groups.collaborationMode) tokenAt(params, 'collaborationMode', request.groups.collaborationMode);
  else if (Object.hasOwn(params, 'collaborationMode')) fail();

  const input = params.input;
  if (!Array.isArray(input)) fail();
  const text = input.filter((item) => (item as JsonObject)?.type === 'text');
  const images = input.filter((item) => (item as JsonObject)?.type === 'localImage');
  const expectedInputLength = (request.groups.prompt ? 1 : 0) + (request.groups.images?.length ?? 0);
  if (input.length !== expectedInputLength) fail();
  if (request.groups.prompt) {
    if (text.length !== 1 || (text[0] as JsonObject).text !== request.groups.prompt) fail();
  } else if (text.length !== 0) fail();
  if ((request.groups.images ?? []).length !== images.length) fail();
  if (request.groups.images) {
    const imageTokens = new Set(request.groups.images);
    for (const item of images) {
      const path = (item as JsonObject).path;
      if (typeof path !== 'string' || !imageTokens.has(path)) fail();
      imageTokens.delete(path);
    }
    if (imageTokens.size !== 0) fail();
  }
  if (request.groups.recoveryContext) {
    const value = (params.additionalContext as JsonObject | undefined)?.['cat-cafe.capacity-recovery'] as JsonObject | undefined;
    if (value?.value !== request.groups.recoveryContext) fail();
  } else if (Object.hasOwn(params, 'additionalContext')) fail();

  const used = new Set<string>();
  const mark = (value: unknown): void => {
    if (typeof value === 'string') {
      if (refs.has(value)) used.add(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(mark);
    if (value && typeof value === 'object') Object.values(value as JsonObject).forEach(mark);
  };
  mark(params);
  for (const token of refs.keys()) if (!used.has(token)) fail();

  return {
    params: expand(params, refs) as JsonObject,
    ...(plan.assertCurrent ? { assertCurrent: plan.assertCurrent } : {}),
  };
}

function groupsThreadId(request: AgentAccessCodexAppServerTurnRequest): string {
  return request.groups.threadId;
}
