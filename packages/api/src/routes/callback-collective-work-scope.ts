import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  COLLECTIVE_WORK_TOOLS,
  normalizeToolExecutionName,
} from '../domains/cats/services/agents/invocation/tool-execution-policy.js';
import { isCollectiveDocumentFile } from '../infrastructure/document/collective-document-scope.js';

/** This guard also covers legacy Work records and callback plugins that opt out of the generic read-only policy. */
export function allowCollectiveWorkScope(
  request: FastifyRequest,
  reply: FastifyReply,
  record: InvocationRecord,
): boolean {
  const binding = record.collectiveWorkBinding;
  if (!binding) return true;
  const route = request.routeOptions.url?.match(/^\/api\/callbacks\/([^/]+)$/)?.[1];
  const tool = normalizeToolExecutionName(route ?? 'unsupported');
  const deny = (reason: string): false => {
    reply.status(403).send({
      error: 'collective_work_scope_violation',
      reason,
      tool,
      ...(tool === 'cat_cafe_update_workflow_sop' ? { code: 'strict_owner_auth_required' } : {}),
    });
    return false;
  };
  if (!COLLECTIVE_WORK_TOOLS.has(tool)) return deny('tool_outside_admitted_work');
  const body = object(request.body);
  const query = object(request.query);
  const scopeFailure = requestScopeFailure([body, query], record.threadId, binding.taskId);
  if (scopeFailure) return deny(scopeFailure);
  if (tool === 'cat_cafe_list_tasks') {
    // Existing handler defaults to all owner threads. Pin its consumer, including omitted filters.
    query.threadId = record.threadId;
    query.taskId = binding.taskId;
  }
  const actionFailure = workActionFailure(tool, body, query, binding.taskId);
  if (
    tool === 'cat_cafe_update_entrusted_work' &&
    record.toolExecutionPolicy?.mode === 'collective_work' &&
    (!Array.isArray(body.artifactRefs) ||
      body.artifactRefs.some(
        (ref) =>
          typeof ref !== 'string' ||
          !ref.startsWith('/uploads/') ||
          !isCollectiveDocumentFile(
            {
              userId: record.userId,
              taskId: binding.taskId,
              executionRevision: binding.executionRevision ?? 1,
              resultRevision: binding.resultRevision,
            },
            ref.slice('/uploads/'.length),
          ),
      ))
  )
    return deny('artifact_outside_admitted_execution');
  return actionFailure ? deny(actionFailure) : true;
}

function requestScopeFailure(inputs: Record<string, unknown>[], threadId: string, taskId: string): string | undefined {
  for (const input of inputs) {
    for (const key of ['threadId', 'targetThreadId', 'sourceThreadId']) {
      if (input[key] !== undefined && input[key] !== threadId) return 'thread_outside_admitted_work';
    }
    if (input.taskId !== undefined && input.taskId !== taskId) return 'task_outside_admitted_work';
  }
  return undefined;
}

function workActionFailure(
  tool: string,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
  taskId: string,
): string | undefined {
  if (tool === 'cat_cafe_read_entrusted_work' && (body.taskId ?? query.taskId) !== taskId) return 'exact_task_required';
  if (
    tool === 'cat_cafe_update_entrusted_work' &&
    (body.taskId !== taskId ||
      body.artifactRefs === undefined ||
      Object.keys(body).some(
        (key) => !['taskId', 'expectedRevision', 'artifactRefs', 'invocationId', 'callbackToken'].includes(key),
      ))
  )
    return 'artifact_registration_only';
  if (
    tool === 'cat_cafe_update_task' &&
    (body.taskId !== taskId ||
      body.status === 'done' ||
      Object.keys(body).some((key) => !['taskId', 'status', 'invocationId', 'callbackToken'].includes(key)))
  )
    return 'service_acceptance_required_for_closure';
  if (
    tool === 'cat_cafe_post_message' &&
    [
      'action',
      'coordination',
      'localReviewVerdict',
      'reviewedHeadSha',
      'reviewSubjectRef',
      'acceptedSourceRef',
      'acceptedRevision',
    ].some((key) => body[key] !== undefined)
  )
    return 'control_plane_action_outside_work';
  return undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
