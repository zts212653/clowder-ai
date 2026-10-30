/**
 * Fail-closed ACP permission policy.
 *
 * An ACP agent's `session/request_permission` is only ever granted by an
 * explicit authority:
 *  - the member's own `acp.autoApprove: true` setting (scoped to that member), or
 *  - a human decision through the shared RuntimeInteractionPort approval card.
 *
 * A missing handler, an unreachable/failed approval owner, a timeout or an
 * unparseable request never becomes an allow. The fallback selects an offered
 * reject option, or answers `cancelled` when the agent offered none.
 */

import type { RuntimeInteractionDecision, RuntimeInteractionOwner, RuntimeInteractionRequest } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { RuntimeInteractionPort } from '../../../../../runtime-interaction/ports/RuntimeInteractionPort.js';
import type { AcpPermissionHandler } from './AcpClient.js';
import type { AcpAgentRequest } from './types.js';

const log = createModuleLogger('acp-permission-policy');

export type AcpPermissionResult = { optionId: string } | { cancelled: true };

interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

/** Where a permission answer came from — logged with every decision. */
export type AcpPermissionDecisionSource =
  | 'member_auto_approve'
  | 'runtime_interaction'
  | 'fail_closed_no_owner'
  | 'fail_closed_owner_error';

function permissionOptions(params: unknown): PermissionOption[] {
  const raw = (params as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (option): option is PermissionOption =>
      Boolean(option) && typeof (option as PermissionOption).optionId === 'string',
  );
}

/** Deny without inventing a grant: explicit reject option, else cancelled. */
export function failClosedPermissionResult(params: unknown): AcpPermissionResult {
  const options = permissionOptions(params);
  const reject =
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always') ??
    options.find((option) => option.optionId === 'reject');
  return reject ? { optionId: reject.optionId } : { cancelled: true };
}

/**
 * Explicit member opt-in. allow_once is preferred over allow_always so a later
 * policy change is not outlived by a session-wide grant; an agent offering only
 * a session-scope allow still gets that option.
 */
function memberAutoApproveResult(params: unknown): AcpPermissionResult {
  const options = permissionOptions(params);
  const allow =
    options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always');
  return allow ? { optionId: allow.optionId } : failClosedPermissionResult(params);
}

function decisionOutcome(kind: string | undefined): RuntimeInteractionDecision['outcome'] {
  if (kind === 'allow_once' || kind === 'allow_always') return 'accept';
  return 'decline';
}

function describePermission(params: Record<string, unknown>): string | undefined {
  const toolCall = params.toolCall as { title?: unknown; kind?: unknown } | undefined;
  const parts = [toolCall?.title, toolCall?.kind, params.description].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export interface AcpPermissionHandlerInput {
  catId: string;
  providerId: string;
  sessionId: string;
  /** Member-level `acp.autoApprove === true`. */
  autoApprove: boolean;
  port?: Pick<RuntimeInteractionPort, 'request'>;
  owner?: RuntimeInteractionOwner;
  signal?: AbortSignal;
  /** Shared by every session handler of one invocation (fresh-session retries). */
  queue?: AcpApprovalQueue;
  /** Defaults to ACP_APPROVAL_TIMEOUT_MS. */
  approvalTimeoutMs?: number;
  createInteractionId?: () => string;
  now?: () => number;
}

export function createAcpPermissionHandler(input: AcpPermissionHandlerInput): AcpPermissionHandler {
  const ownQueue = createAcpApprovalQueue();
  const decide = (
    req: AcpAgentRequest,
    respond: (result: AcpPermissionResult) => void,
    source: AcpPermissionDecisionSource,
    result: AcpPermissionResult,
    reason?: string,
  ) => {
    const granted = 'optionId' in result && decisionOutcome(optionKind(req.params, result.optionId)) === 'accept';
    log.info(
      {
        catId: input.catId,
        sessionId: input.sessionId,
        requestId: req.id,
        source,
        granted,
        ...(reason ? { reason } : {}),
      },
      'ACP permission decision',
    );
    respond(result);
  };

  return async (req, respond) => {
    if (input.autoApprove) {
      decide(req, respond, 'member_auto_approve', memberAutoApproveResult(req.params));
      return;
    }
    const options = permissionOptions(req.params);
    if (!input.port || !input.owner || options.length === 0) {
      decide(
        req,
        respond,
        'fail_closed_no_owner',
        failClosedPermissionResult(req.params),
        !input.port || !input.owner ? 'no approval owner for this invocation' : 'agent offered no options',
      );
      return;
    }
    const decisions: RuntimeInteractionDecision[] = options.map((option) => ({
      id: option.optionId,
      label: option.name?.trim() || option.optionId,
      outcome: decisionOutcome(option.kind),
    }));
    if (!decisions.some((decision) => decision.outcome !== 'accept')) {
      decisions.push({ id: '__cancel__', label: '拒绝并取消', outcome: 'cancel' });
    }
    const port = input.port;
    const description = describePermission(req.params);
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: input.createInteractionId?.() ?? crypto.randomUUID(),
      kind: 'approval',
      owner: input.owner,
      provider: {
        providerId: input.providerId,
        method: 'session/request_permission',
        requestId: req.id,
        threadId: input.sessionId,
      },
      createdAt: input.now?.() ?? Date.now(),
      title: '允许这次工具操作？',
      ...(description ? { description } : {}),
      decisions,
    };
    // One provider interaction may be active per invocation, so parallel tool
    // calls wait their turn instead of being rejected as duplicates. Each card's
    // wait is bounded: on timeout or abort the card is invalidated and we deny.
    const queue = input.queue ?? ownQueue;
    const run = queue.tail
      .catch(() => undefined)
      .then(async () => {
        if (input.signal?.aborted) throw new Error('invocation aborted before the approval card opened');
        const timeout = AbortSignal.timeout(input.approvalTimeoutMs ?? ACP_APPROVAL_TIMEOUT_MS);
        const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
        const response = await port.request(request, { signal });
        if (response.kind !== 'decision') throw new Error('approval interaction requires a decision response');
        return response.decisionId;
      });
    queue.tail = run;
    try {
      const decisionId = await run;
      const chosen = options.find((option) => option.optionId === decisionId);
      decide(req, respond, 'runtime_interaction', chosen ? { optionId: chosen.optionId } : { cancelled: true });
    } catch (error) {
      decide(
        req,
        respond,
        'fail_closed_owner_error',
        failClosedPermissionResult(req.params),
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

/** A human decision is awaited this long before the request fails closed. */
export const ACP_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Serializes approval cards across the sessions of one invocation. */
export interface AcpApprovalQueue {
  tail: Promise<unknown>;
}

export function createAcpApprovalQueue(): AcpApprovalQueue {
  return { tail: Promise.resolve() };
}

function optionKind(params: unknown, optionId: string): string | undefined {
  return permissionOptions(params).find((option) => option.optionId === optionId)?.kind;
}
