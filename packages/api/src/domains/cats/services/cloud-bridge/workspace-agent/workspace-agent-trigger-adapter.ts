/**
 * F247 Workspace Agent (slice 1): Trigger API adapter.
 *
 * Narrow outbound seam for one Workspace Agent trigger dispatch:
 *   POST /v1/workspace_agents/{id}/trigger  (Bearer workspace-agent token)
 *   body: { input, conversation_key }
 *   headers: Idempotency-Key (bound to the exact dispatch), optional beta runs
 *
 * Contract consequences pinned here:
 *  - The API returns 202 + { conversation_url } and nothing about the agent's
 *    eventual answer; the adapter MUST NOT treat run status as the return
 *    path. Exact return stays the Remote MCP `cat_cafe_post_message(replyTo)`
 *    seam (F247 AC-B1c-12 fixed return contract + server-custody grant).
 *  - `providerRunId` (beta `apirun_*`) is transport telemetry only.
 *  - The access token is passed per call and never stored, logged, or
 *    serialized — error messages carry status/typed code only (redaction).
 */

import { buildWorkspaceAgentConversationKey } from './conversation-key.js';

const TRIGGER_ENDPOINT_ORIGIN = 'https://api.chatgpt.com';
const RUNS_BETA_HEADER = 'workspace_agent_runs=v1';

export type WorkspaceAgentTriggerErrorCode =
  | 'WORKSPACE_AGENT_UNAUTHORIZED' // 401 — token bad/expired, needs re-auth
  | 'WORKSPACE_AGENT_FORBIDDEN' // 403 — token lacks Workspace Agents scope
  | 'WORKSPACE_AGENT_TRIGGER_NOT_FOUND' // 404 — trigger id wrong or deleted
  | 'WORKSPACE_AGENT_NOT_RUNNABLE' // 409 — agent/channel not runnable
  | 'WORKSPACE_AGENT_TRANSPORT_ERROR' // network / non-JSON / unexpected shape
  | 'WORKSPACE_AGENT_INVALID_CONFIG'; // missing trigger id / token / input

export class WorkspaceAgentTriggerError extends Error {
  constructor(
    public readonly code: WorkspaceAgentTriggerErrorCode,
    message: string,
    /** HTTP status when the provider answered (absent for transport faults). */
    public readonly status?: number,
  ) {
    // Message is constructed by this module only from typed context — it must
    // never interpolate the token or the raw response body.
    super(message);
    this.name = 'WorkspaceAgentTriggerError';
  }
}

export interface WorkspaceAgentTriggerReceipt {
  /** 202 conversation_url — owner-only projection, never a thread-scoped receipt field. */
  readonly conversationUrl: string;
  /**
   * Beta run id (apirun_*) — transport telemetry only, never a return-path
   * substitute. Note: the 202 body cannot distinguish a fresh accept from an
   * idempotent replay; the fresh/replayed truth stays in the server-side
   * durable idempotency ledger (receipt disposition), not here.
   */
  readonly providerRunId?: string;
}

export interface WorkspaceAgentTriggerArgs {
  readonly input: string;
  readonly conversationKey: string;
  /** Idempotency-Key — bound by the caller to the exact dispatch (dispatchInvocationId). */
  readonly idempotencyKey: string;
}

/** Per-call token provider — keeps custody server-side (env/settings store), never in the adapter. */
export type WorkspaceAgentTokenProvider = () => string | null | undefined;

export interface IWorkspaceAgentTriggerAdapter {
  readonly triggerId: string;
  trigger(args: WorkspaceAgentTriggerArgs): Promise<WorkspaceAgentTriggerReceipt>;
}

export interface WorkspaceAgentHttpAdapterConfig {
  readonly triggerId: string;
  readonly tokenProvider: WorkspaceAgentTokenProvider;
  /** Injectable for tests; production default is global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock-free determinism for tests. */
  readonly origin?: string;
  /** Request timeout. Default 15s; the caller only awaits the bounded 202 boundary. */
  readonly timeoutMs?: number;
}

function requireNonEmpty(value: string | null | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceAgentTriggerError('WORKSPACE_AGENT_INVALID_CONFIG', `${field} is required`);
  }
  return value;
}

const CONVERSATION_URL_REGEX = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+\/?$/;

export class WorkspaceAgentTriggerHttpAdapter implements IWorkspaceAgentTriggerAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly normalizedTriggerId: string;

  constructor(config: WorkspaceAgentHttpAdapterConfig) {
    this.normalizedTriggerId = requireNonEmpty(config.triggerId, 'triggerId');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.origin = config.origin ?? TRIGGER_ENDPOINT_ORIGIN;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.tokenProvider = config.tokenProvider;
  }

  private readonly tokenProvider: WorkspaceAgentTokenProvider;

  get triggerId(): string {
    return this.normalizedTriggerId;
  }

  async trigger(args: WorkspaceAgentTriggerArgs): Promise<WorkspaceAgentTriggerReceipt> {
    const token = requireNonEmpty(this.tokenProvider(), 'workspace agent access token');
    const input = requireNonEmpty(args.input, 'trigger input');
    const idempotencyKey = requireNonEmpty(args.idempotencyKey, 'idempotencyKey');
    if (!args.conversationKey.includes(':')) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_INVALID_CONFIG',
        'conversationKey must be built via buildWorkspaceAgentConversationKey',
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.origin}/v1/workspace_agents/${encodeURIComponent(this.triggerId)}/trigger`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            'OpenAI-Beta': RUNS_BETA_HEADER,
          },
          body: JSON.stringify({ input, conversation_key: args.conversationKey }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      // Transport fault: never surface headers/body (token redaction by construction).
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_TRANSPORT_ERROR',
        `Workspace Agent trigger request failed before a provider response: ${(err as Error).name}`,
      );
    }

    if (response.status === 401) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_UNAUTHORIZED',
        'Workspace Agent token was rejected (401) — re-authorize in Settings',
        401,
      );
    }
    if (response.status === 403) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_FORBIDDEN',
        'Workspace Agent token lacks the required Workspace Agents scope (403)',
        403,
      );
    }
    if (response.status === 404) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_TRIGGER_NOT_FOUND',
        'Workspace Agent trigger id was not found (404)',
        404,
      );
    }
    if (response.status === 409) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_NOT_RUNNABLE',
        'Workspace Agent is not runnable on this channel (409)',
        409,
      );
    }
    if (response.status !== 202) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_TRANSPORT_ERROR',
        `Workspace Agent trigger returned unexpected status ${response.status}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_TRANSPORT_ERROR',
        'Workspace Agent trigger 202 response was not valid JSON',
        202,
      );
    }
    const conversationUrl = (body as { conversation_url?: unknown }).conversation_url;
    if (typeof conversationUrl !== 'string' || !CONVERSATION_URL_REGEX.test(conversationUrl)) {
      throw new WorkspaceAgentTriggerError(
        'WORKSPACE_AGENT_TRANSPORT_ERROR',
        'Workspace Agent trigger 202 response lacked a canonical conversation_url',
        202,
      );
    }
    const providerRunId = (body as { agent_trigger_run_id?: unknown }).agent_trigger_run_id;
    return {
      conversationUrl,
      ...(typeof providerRunId === 'string' && providerRunId.length > 0 ? { providerRunId } : {}),
    };
  }
}

export { buildWorkspaceAgentConversationKey };
