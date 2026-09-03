import type {
  EntrustedWorkTaskRefV1,
  RuntimeInteractionDecision,
  RuntimeInteractionOwner,
  RuntimeInteractionProviderRef,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type { RuntimeInteractionPort } from '../../../../runtime-interaction/ports/RuntimeInteractionPort.js';
import { isCodexMcpApprovalCompatibilityRequest } from './CodexAppServerEventMapper.js';
import {
  commandParamsSchema,
  fileParamsSchema,
  mcpFormParamsSchema,
  mcpUrlParamsSchema,
  normalizeCodexMcpFormSchema,
  questionParamsSchema,
} from './CodexRuntimeInteractionSchema.js';

type JsonObject = Record<string, unknown>;

const supportedMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

export interface CodexRuntimeInteractionContext {
  owner: RuntimeInteractionOwner;
  port: Pick<RuntimeInteractionPort, 'request'> & Partial<Pick<RuntimeInteractionPort, 'invalidateInvocation'>>;
  signal?: AbortSignal;
  createInteractionId?: () => string;
  now?: () => number;
  resolveEntrustedWorkTaskRef?: () => Promise<EntrustedWorkTaskRefV1 | undefined>;
}

export async function respondToCodexRuntimeInteraction(
  envelope: JsonObject,
  context: CodexRuntimeInteractionContext,
): Promise<JsonObject | null> {
  const method = envelope.method;
  if (!isCodexRuntimeInteractionMethod(method) || isCodexMcpApprovalCompatibilityRequest(envelope)) return null;
  if (typeof envelope.id !== 'number' || !Number.isInteger(envelope.id)) return null;
  try {
    const entrustedWorkTaskRef =
      method === 'item/tool/requestUserInput'
        ? await resolveEntrustedWorkTaskRef(context.resolveEntrustedWorkTaskRef)
        : undefined;
    const binding = buildBinding(envelope.id, method, envelope.params, context, entrustedWorkTaskRef);
    const response = await context.port.request(
      binding.request,
      context.signal ? { signal: context.signal } : undefined,
    );
    return { id: envelope.id, result: binding.toProviderResponse(response) };
  } catch (error) {
    const reasonCode = interactionReasonCode(error);
    if (reasonCode) {
      return {
        id: envelope.id,
        error: {
          code: -32001,
          message: 'Runtime interaction unavailable',
          data: { reasonCode },
        },
      };
    }
    return { id: envelope.id, error: { code: -32602, message: `Invalid ${method} request` } };
  }
}

export function isCodexRuntimeInteractionMethod(method: unknown): method is string {
  return typeof method === 'string' && supportedMethods.has(method);
}

export function isCodexApprovalInteractionMethod(method: unknown): method is string {
  return method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
}

interface CodexInteractionBinding {
  request: RuntimeInteractionRequest;
  toProviderResponse(response: RuntimeInteractionResponse): JsonObject;
}

function buildBinding(
  requestId: number,
  method: string,
  params: unknown,
  context: CodexRuntimeInteractionContext,
  entrustedWorkTaskRef?: EntrustedWorkTaskRefV1,
): CodexInteractionBinding {
  const interactionId = context.createInteractionId?.() ?? crypto.randomUUID();
  const now = context.now?.() ?? Date.now();
  if (method === 'item/commandExecution/requestApproval') {
    const parsed = commandParamsSchema.parse(params);
    const provider = providerRef(requestId, method, parsed);
    const decisions: RuntimeInteractionDecision[] = [
      decision('accept', '允许一次', 'accept'),
      decision('acceptForSession', '本次会话允许', 'accept'),
    ];
    const providerDecisions = new Map<string, unknown>([
      ['accept', 'accept'],
      ['acceptForSession', 'acceptForSession'],
    ]);
    if (parsed.proposedExecpolicyAmendment?.length) {
      decisions.push(decision('acceptWithExecpolicyAmendment', '允许并应用命令规则', 'accept'));
      providerDecisions.set('acceptWithExecpolicyAmendment', {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: parsed.proposedExecpolicyAmendment },
      });
    }
    for (const [index, amendment] of (parsed.proposedNetworkPolicyAmendments ?? []).entries()) {
      const id = `applyNetworkPolicyAmendment:${index}`;
      decisions.push(
        decision(id, `${amendment.action === 'allow' ? '允许' : '拒绝'} ${amendment.host} 并记住`, 'accept'),
      );
      providerDecisions.set(id, { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
    }
    decisions.push(decision('decline', '拒绝', 'decline'), decision('cancel', '拒绝并停止本轮', 'cancel'));
    providerDecisions.set('decline', 'decline');
    providerDecisions.set('cancel', 'cancel');
    return {
      request: {
        ...baseRequest(interactionId, context.owner, provider, parsed.startedAtMs, '运行这条命令？'),
        kind: 'approval',
        description: approvalDescription(parsed.command, parsed.reason, parsed.cwd),
        decisions,
      },
      toProviderResponse: (response) => ({ decision: providerDecision(response, providerDecisions) }),
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const parsed = fileParamsSchema.parse(params);
    const provider = providerRef(requestId, method, parsed);
    const decisions = fixedApprovalDecisions();
    return {
      request: {
        ...baseRequest(interactionId, context.owner, provider, parsed.startedAtMs, '应用文件修改？'),
        kind: 'approval',
        description: approvalDescription(parsed.reason, parsed.grantRoot),
        decisions,
      },
      toProviderResponse: (response) => ({ decision: fixedDecision(response) }),
    };
  }
  if (method === 'item/tool/requestUserInput') {
    const parsed = questionParamsSchema.parse(params);
    const provider = providerRef(requestId, method, parsed);
    return {
      request: {
        ...baseRequest(interactionId, context.owner, provider, now, 'Codex 需要你的回答'),
        ...(entrustedWorkTaskRef ? { entrustedWorkTaskRef } : {}),
        kind: 'question',
        questions: parsed.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          ...(question.isOther === undefined ? {} : { isOther: question.isOther }),
          ...(question.isSecret === undefined ? {} : { isSecret: question.isSecret }),
          ...(question.options?.length ? { options: question.options } : {}),
        })),
      },
      toProviderResponse: (response) => ({
        answers: Object.fromEntries(answerResponse(response).map(([id, answers]) => [id, { answers }])),
      }),
    };
  }
  const form = mcpFormParamsSchema.safeParse(params);
  if (form.success) {
    const provider = providerRef(requestId, method, form.data);
    return {
      request: {
        ...baseRequest(interactionId, context.owner, provider, now, `${form.data.serverName} 需要补充信息`),
        kind: 'elicitation',
        mode: 'form',
        message: form.data.message,
        requestedSchema: normalizeCodexMcpFormSchema(form.data.requestedSchema),
        decisions: elicitationDecisions(),
      },
      toProviderResponse: (response) => elicitationResponse(response),
    };
  }
  const url = mcpUrlParamsSchema.parse(params);
  const provider = providerRef(requestId, method, url);
  return {
    request: {
      ...baseRequest(interactionId, context.owner, provider, now, `${url.serverName} 需要你完成操作`),
      kind: 'elicitation',
      mode: 'url',
      message: url.message,
      elicitationId: url.elicitationId,
      url: url.url,
      decisions: elicitationDecisions(),
    },
    toProviderResponse: (response) => elicitationResponse(response),
  };
}

async function resolveEntrustedWorkTaskRef(
  resolver: CodexRuntimeInteractionContext['resolveEntrustedWorkTaskRef'],
): Promise<EntrustedWorkTaskRefV1 | undefined> {
  if (!resolver) return undefined;
  try {
    return await resolver();
  } catch {
    // Native F306 questions remain valid when Task truth is unavailable. They
    // simply stay absent from Needs Me until a canonical link can be proved.
    return undefined;
  }
}

function baseRequest(
  interactionId: string,
  owner: RuntimeInteractionOwner,
  provider: RuntimeInteractionProviderRef,
  createdAt: number,
  title: string,
) {
  return { version: 1 as const, interactionId, owner, provider, createdAt, title };
}

function providerRef(
  requestId: number,
  method: string,
  params: { threadId: string; turnId?: string | null; itemId?: string },
): RuntimeInteractionProviderRef {
  return {
    providerId: 'openai',
    method,
    requestId,
    threadId: params.threadId,
    ...(params.turnId === undefined ? {} : { turnId: params.turnId }),
    ...(params.itemId ? { itemId: params.itemId } : {}),
  };
}

function decision(
  id: string,
  label: string,
  outcome: RuntimeInteractionDecision['outcome'],
): RuntimeInteractionDecision {
  return { id, label, outcome };
}

function fixedApprovalDecisions(): RuntimeInteractionDecision[] {
  return [
    decision('accept', '允许一次', 'accept'),
    decision('acceptForSession', '本次会话允许', 'accept'),
    decision('decline', '拒绝', 'decline'),
    decision('cancel', '拒绝并停止本轮', 'cancel'),
  ];
}

function elicitationDecisions(): RuntimeInteractionDecision[] {
  return [
    decision('accept', '提交', 'accept'),
    decision('decline', '拒绝', 'decline'),
    decision('cancel', '取消', 'cancel'),
  ];
}

function fixedDecision(response: RuntimeInteractionResponse): string {
  if (
    response.kind !== 'decision' ||
    !['accept', 'acceptForSession', 'decline', 'cancel'].includes(response.decisionId)
  ) {
    throw new Error('invalid approval response');
  }
  return response.decisionId;
}

function providerDecision(response: RuntimeInteractionResponse, decisions: Map<string, unknown>): unknown {
  if (response.kind !== 'decision' || !decisions.has(response.decisionId)) throw new Error('invalid approval response');
  return decisions.get(response.decisionId);
}

function answerResponse(response: RuntimeInteractionResponse): Array<[string, string[]]> {
  if (response.kind !== 'answers') throw new Error('invalid question response');
  return Object.entries(response.answers);
}

function elicitationResponse(response: RuntimeInteractionResponse): JsonObject {
  if (response.kind !== 'decision' || !['accept', 'decline', 'cancel'].includes(response.decisionId)) {
    throw new Error('invalid elicitation response');
  }
  return {
    action: response.decisionId,
    ...(response.decisionId === 'accept' && response.content ? { content: response.content } : {}),
  };
}

function approvalDescription(...parts: Array<string | null | undefined>): string | undefined {
  const content = parts.filter((part): part is string => Boolean(part?.trim())).join('\n\n');
  return content || undefined;
}

function interactionReasonCode(error: unknown): RuntimeInteractionTerminalReasonCode | null {
  const reasonCode = (error as { reasonCode?: unknown } | null)?.reasonCode;
  const allowed: RuntimeInteractionTerminalReasonCode[] = [
    'answered',
    'user_rejected',
    'user_cancelled',
    'confirmation_unavailable',
    'host_restarted',
    'transport_lost',
    'provider_cancelled',
    'surface_publication_failed',
  ];
  return typeof reasonCode === 'string' && allowed.includes(reasonCode as RuntimeInteractionTerminalReasonCode)
    ? (reasonCode as RuntimeInteractionTerminalReasonCode)
    : null;
}
