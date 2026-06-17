/**
 * MCP Callback Tools — core callbacks
 * 鉴权: process.env CAT_CAFE_INVOCATION_ID + CAT_CAFE_CALLBACK_TOKEN
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CallbackAuthFailureReason, DispatchGateState, SuggestedCrossPostAction } from '@cat-cafe/shared';
import {
  CALLBACK_AUTH_FAILURE_REASONS,
  DEVELOPMENT_SOP_STAGE_IDS,
  extractFeatureIds,
  isCallbackAuthFailureReason,
  isValidRichBlock,
  normalizeRichBlock,
  SOP_DEFINITION_IDS,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { sendCallbackRequest } from './callback-outbox.js';
import { extractReasonTag } from './callback-retry.js';
import { formatSuggestedCrossPostActionLines } from './cross-post-suggestion-format.js';
import { withDegradation } from './degradation.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

/**
 * F174 Phase A — reason taxonomy lives in @cat-cafe/shared (single source of
 * truth shared with the API). Aliased here for local readability.
 */
type AuthFailureReason = CallbackAuthFailureReason;
const KNOWN_REASONS: ReadonlySet<AuthFailureReason> = new Set(CALLBACK_AUTH_FAILURE_REASONS);

/**
 * Parse the structured reason tag added by the retry layer (or callbackGet)
 * into a typed AuthFailureReason. Returns undefined if no tag, the tag is
 * malformed, or the reason is unknown — callers must handle that case.
 */
function parseAuthFailureReason(errorText: string): AuthFailureReason | undefined {
  const match = /\[reason=([a-z_]+)\]/.exec(errorText);
  if (!match) return undefined;
  const reason = match[1];
  // Use shared type guard so an unknown reason from a future server doesn't
  // get silently coerced into our local enum.
  if (reason && isCallbackAuthFailureReason(reason) && KNOWN_REASONS.has(reason)) {
    return reason;
  }
  return undefined;
}

// F174 Phase E: degradation policy + DEGRADABLE_AUTH_REASONS moved to
// ./degradation.ts so other write-class tools share a single source of truth.

interface CallbackConfig {
  apiUrl: string;
  invocationId?: string;
  callbackToken?: string;
  agentKeySecret?: string;
}

interface AgentKeyOptions {
  agentKeyCatId?: string;
  forceAgentKey?: boolean;
}

function readAgentKeyFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    // sidecar missing = no agent-key (not an error)
    return undefined;
  }
}

function parseAgentKeyFileMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const files: Record<string, string> = {};
    for (const [catId, filePath] of Object.entries(parsed)) {
      if (typeof filePath === 'string' && filePath.trim()) {
        files[catId] = filePath.trim();
      }
    }
    return files;
  } catch {
    return {};
  }
}

function resolveAgentKeySecret(options?: AgentKeyOptions): string | undefined {
  const requestedCatId = options?.agentKeyCatId?.trim();
  const variantMapRaw = process.env.CAT_CAFE_AGENT_KEY_FILES?.trim();
  if (requestedCatId) {
    const variantFiles = parseAgentKeyFileMap(variantMapRaw);
    return readAgentKeyFile(variantFiles[requestedCatId]);
  }

  if (variantMapRaw) return undefined;

  const agentKeySecret = process.env.CAT_CAFE_AGENT_KEY_SECRET;
  if (agentKeySecret) return agentKeySecret;

  return readAgentKeyFile(process.env.CAT_CAFE_AGENT_KEY_FILE);
}

export function getCallbackConfig(options?: AgentKeyOptions): CallbackConfig | null {
  const apiUrl = process.env.CAT_CAFE_API_URL;
  if (!apiUrl) return null;

  const invocationId = process.env.CAT_CAFE_INVOCATION_ID;
  const callbackToken = process.env.CAT_CAFE_CALLBACK_TOKEN;
  const agentKeySecret = resolveAgentKeySecret(options);
  if (options?.forceAgentKey === true) {
    if (!agentKeySecret) return null;
    return { apiUrl, agentKeySecret };
  }

  if (!invocationId && !callbackToken && !agentKeySecret) return null;

  const hasFullInvocation = invocationId && callbackToken;
  if ((invocationId || callbackToken) && !hasFullInvocation && !agentKeySecret) return null;

  return {
    apiUrl,
    ...(hasFullInvocation ? { invocationId, callbackToken } : {}),
    ...(agentKeySecret ? { agentKeySecret } : {}),
  };
}

export const NO_CONFIG_ERROR =
  'Clowder AI callback not configured. Missing callback credentials, agent-key credentials, or required agentKeyCatId for shared Antigravity MCP.';
// ============ HTTP helpers ============

export function buildAuthHeaders(config: CallbackConfig): Record<string, string> {
  if (config.invocationId && config.callbackToken) {
    return {
      'x-invocation-id': config.invocationId,
      'x-callback-token': config.callbackToken,
    };
  }
  if (config.agentKeySecret) {
    return { 'x-agent-key-secret': config.agentKeySecret };
  }
  return {};
}

// F174 Phase F (AC-F2): first-party MCP client stopped dual-writing creds to
// body/query. Headers are now the only place we put credentials. Server still
// accepts body/query as fallback for legacy MCP clients during the compat
// window — that fallback usage is tracked via callback-auth-telemetry's
// `recordLegacyFallbackHit` so we know when it's safe to delete the schema.

/** KD-6: Format a CatRoutingError as a human-readable prefix for the LLM.
 * Format: `Cat routing failed [kind=X] target=@Y ...\nAlternatives: @A, @B.` */
export function formatCatRoutingErrorPrefix(body: {
  kind: string;
  catId?: string;
  mention?: string;
  alternatives?: Array<{ mention: string; displayName?: string }>;
}): string {
  const target = body.catId ? `@${body.catId}` : (body.mention ?? 'unknown');
  let msg = `Cat routing failed [kind=${body.kind}] target=${target}`;
  if (body.kind === 'cat_disabled') msg += ' disabled.';
  else if (body.kind === 'cat_not_found') msg += ' not found.';
  const alts = body.alternatives
    ?.slice(0, 3)
    .map((a) => `${a.mention}${a.displayName ? ` (${a.displayName})` : ''}`)
    .join(', ');
  if (alts) msg += `\nAlternatives: ${alts}.`;
  return msg;
}

export async function callbackPost(
  path: string,
  body: Record<string, unknown>,
  options?: {
    enableOutbox?: boolean;
    agentKeyCatId?: string;
    forceAgentKey?: boolean;
    retryDelaysMs?: number[];
    fetchTimeoutMs?: number;
  },
): Promise<ToolResult> {
  const config = getCallbackConfig({
    agentKeyCatId: options?.agentKeyCatId,
    forceAgentKey: options?.forceAgentKey,
  });
  if (!config) return errorResult(NO_CONFIG_ERROR);

  const result = await sendCallbackRequest(
    {
      apiUrl: config.apiUrl,
      path,
      body, // headers-only auth (Phase F AC-F2)
      headers: buildAuthHeaders(config),
    },
    {
      enableOutbox: options?.enableOutbox === true,
      retryDelaysMs: options?.retryDelaysMs,
      fetchTimeoutMs: options?.fetchTimeoutMs,
    },
  );
  if (result.ok) return successResult(JSON.stringify(result.data));

  // KD-6: detect 400 CatRoutingError and prepend human-readable prefix + JSON dual-track
  const errText = result.error;
  const match400 = errText.match(/^Callback failed \(400\): ([\s\S]+)$/);
  if (match400) {
    try {
      const parsed = JSON.parse(match400[1]) as { kind?: unknown };
      if (parsed.kind === 'cat_disabled' || parsed.kind === 'cat_not_found') {
        const prefix = formatCatRoutingErrorPrefix(parsed as Parameters<typeof formatCatRoutingErrorPrefix>[0]);
        return errorResult(`${prefix}\n${match400[1]}`);
      }
    } catch {
      /* not JSON — fall through to raw error */
    }
  }
  return errorResult(errText);
}

export async function callbackGet(
  path: string,
  params?: Record<string, string>,
  options?: AgentKeyOptions,
): Promise<ToolResult> {
  const config = getCallbackConfig(options);
  if (!config) return errorResult(NO_CONFIG_ERROR);

  const query = new URLSearchParams(params ?? {}); // headers-only auth (Phase F AC-F2)
  const qs = query.toString();
  const url = qs ? `${config.apiUrl}${path}?${qs}` : `${config.apiUrl}${path}`;

  try {
    const response = await fetch(url, { headers: buildAuthHeaders(config) });
    if (!response.ok) {
      const text = await response.text();
      // F174 Phase A: tag structured reason from 401 callback_auth_failed body
      // so downstream routing matches the postJsonWithRetry error format.
      const reasonTag = response.status === 401 ? extractReasonTag(text) : '';
      return errorResult(`Callback failed (${response.status})${reasonTag}: ${text}`);
    }
    return successResult(JSON.stringify(await response.json()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Callback request failed: ${message}`);
  }
}

const agentKeyCatIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared Antigravity MCP (antigravity or antig-opus) so agent-key auth uses the matching sidecar key; otherwise callback config fails closed. Ignored when full invocation credentials are present.',
  );

export const postMessageInputSchema = {
  content: z.string().min(1).describe('The message content to post'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Target thread ID. Required for agent-key auth (persistent agent with no default thread). Omit for invocation auth (defaults to invocation thread).',
    ),
  replyTo: z.string().optional().describe('Optional message ID to reply to'),
  clientMessageId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key for at-least-once delivery de-duplication'),
  targetCats: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional explicit target cat IDs. Merged with @mentions parsed from content. Use get_thread_cats to discover valid catIds. ' +
        'F182: disabled cats are dropped (soft degradation) — check routing_warnings in response for cat_disabled entries and read alternatives[] to find replacements. ' +
        'Response always includes message field (human-readable routing summary).',
    ),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const getPendingMentionsInputSchema = {
  includeAcked: z
    .boolean()
    .optional()
    .describe('When true, include acknowledged mentions for explicit history review.'),
};

export const ackMentionsInputSchema = {
  upToMessageId: z
    .string()
    .min(1)
    .describe(
      'The message ID up to which mentions have been processed. Must be within the last fetched pending window.',
    ),
};

export const getThreadContextInputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(100)
    .describe('Number of recent messages to retrieve (default: 100, max: 200)'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional: read messages from a different thread. Omit to read the current thread.'),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional: open a bounded context window around a specific message in the selected thread.'),
  before: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe('When messageId is set, number of messages before the target to include (default: 3).'),
  after: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe('When messageId is set, number of messages after the target to include (default: 3).'),
  catId: z.string().min(1).optional().describe("Optional: filter by speaker catId, or pass 'user' for human messages."),
  keyword: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: filter and rank messages by keyword relevance. Multi-word keywords are tokenized and scored (0-1). Results sorted by relevance when keyword is provided.',
    ),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const listThreadsInputSchema = {
  limit: z.number().int().min(1).max(200).optional().default(20).describe('Max threads to return (default: 20).'),
  activeSince: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Optional Unix timestamp in ms; only include threads active at/after this time.'),
  keyword: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional: filter threads whose title or threadId contains this keyword (case-insensitive).'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const listLabelsInputSchema = {
  limit: z.number().int().min(1).max(50).optional().default(50).describe('Max labels to return (default: 50).'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const featIndexInputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Max feature entries to return (default: 20, max: 100).'),
  featId: z.string().min(1).optional().describe('Optional exact feature ID match (case-insensitive), e.g. F043.'),
  query: z
    .string()
    .min(1)
    .optional()
    .describe('Optional fuzzy substring search over featId/name/status (case-insensitive).'),
};

export const createTaskInputSchema = {
  title: z.string().min(1).max(200).describe('Task title — what needs to be done'),
  why: z.string().max(1000).optional().describe('Why this task matters (context for whoever picks it up)'),
  ownerCatId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Cat ID to assign the task to (optional, defaults to unassigned). ' +
        'F182: if disabled, returns 400 {kind:"cat_disabled", alternatives[]}. Assign to an available cat from alternatives[].',
    ),
  // F193 Phase E (dispatch gate)
  relatedFeatureId: z
    .string()
    .regex(/^F\d+$/)
    .optional()
    .describe(
      'Feature ID this task relates to (e.g. "F193"). Optional explicit override — ' +
        'system also auto-extracts F-IDs from title+why. When detected F-IDs differ from ' +
        'currentFeatureId, a dispatch gate warning is returned.',
    ),
  currentFeatureId: z
    .string()
    .regex(/^F\d+$/)
    .optional()
    .describe(
      'The feature ID of your current thread/scope (e.g. "F209"). Used to determine which ' +
        'detected F-IDs are "external". If omitted, all detected F-IDs trigger the dispatch gate.',
    ),
  dispatchGate: z
    .object({
      status: z
        .enum(['dispatched', 'not_dispatched'])
        .describe('Whether you dispatched this info to the owning thread'),
      dispatchedThreadId: z
        .string()
        .optional()
        .describe('Thread ID you dispatched to (required when status=dispatched)'),
      dispatchedMessageId: z
        .string()
        .optional()
        .describe('Message ID of the cross-post (required when status=dispatched)'),
      reason: z.string().optional().describe('Why you chose not to dispatch (required when status=not_dispatched)'),
    })
    .refine(
      (gate) => {
        if (gate.status === 'dispatched') return !!gate.dispatchedThreadId && !!gate.dispatchedMessageId;
        if (gate.status === 'not_dispatched') return !!gate.reason;
        return true;
      },
      {
        message:
          'dispatched requires BOTH dispatchedThreadId AND dispatchedMessageId; ' + 'not_dispatched requires reason.',
      },
    )
    .optional()
    .describe(
      'Dispatch gate decision. Required when task references features outside your current scope. ' +
        'If omitted and external F-IDs detected, task is created with dispatchGate.status="missing" and a warning is returned. ' +
        'When status=dispatched, both dispatchedThreadId and dispatchedMessageId are required. ' +
        'When status=not_dispatched, reason is required.',
    ),
};

export const updateTaskInputSchema = {
  taskId: z.string().min(1).describe('The ID of the task to update'),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional().describe('New task status'),
  why: z.string().max(1000).optional().describe('Optional note explaining the status change'),
  // F193-E1 P1-4 fix: allow patching dispatchGate on existing tasks
  dispatchGate: z
    .object({
      status: z.enum(['dispatched', 'not_dispatched']).describe('Dispatch gate resolution'),
      dispatchedThreadId: z
        .string()
        .optional()
        .describe('Thread ID you dispatched to (required when status=dispatched)'),
      dispatchedMessageId: z
        .string()
        .optional()
        .describe('Message ID of the cross-post (required when status=dispatched)'),
      reason: z.string().optional().describe('Why you chose not to dispatch (required when status=not_dispatched)'),
    })
    .refine(
      (gate) => {
        if (gate.status === 'dispatched') return !!gate.dispatchedThreadId && !!gate.dispatchedMessageId;
        if (gate.status === 'not_dispatched') return !!gate.reason;
        return true;
      },
      {
        message:
          'dispatched requires BOTH dispatchedThreadId AND dispatchedMessageId; ' + 'not_dispatched requires reason.',
      },
    )
    .optional()
    .describe('Resolve a previously-missing dispatch gate on this task.'),
};

export const crossPostMessageInputSchema = {
  threadId: z.string().min(1).describe('Target thread ID to post into'),
  content: z.string().min(1).describe('The message content to post'),
  targetCats: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Cat handles to route the cross-thread notification to (triggers their session in the target thread). ' +
        'Required if content has no line-start @mention — server fail-closes when both routing credentials are missing (F193 AC-A4). ' +
        'F193 KD-1 boundary: this is the routing list, NOT relay metadata. Agent-key callers do not inherit F052 sourceThreadId semantics.',
    ),
  replyTo: z.string().optional().describe('Optional message ID to reply to'),
  clientMessageId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key for at-least-once delivery de-duplication'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const listTasksInputSchema = {
  threadId: z.string().min(1).optional().describe('Optional thread ID filter'),
  catId: z.string().min(1).optional().describe('Optional owner catId filter'),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional().describe('Optional task status filter'),
  kind: z
    .enum(['work', 'pr_tracking'])
    .optional()
    .describe('Optional task kind filter (work = manual tasks, pr_tracking = PR automation)'),
};

/**
 * F193 AC-A4: Plausible line-start @mention detector for MCP-layer
 * fail-closed. Mirrors the authoritative server parser at
 * a2a-mentions.ts:86-114 (strip code fences, trimStart, strip markdown
 * prefix, then `startsWith('@')`). Local copy to avoid cross-package
 * dep — server-side parser remains authoritative; this is just an
 * early-reject to (a) save an HTTP roundtrip and (b) cover the
 * agent-key API-layer gap (where isCrossThread never fires).
 */
const LEADING_MARKDOWN_MENTION_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;

function hasPlausibleLineStartMention(content: string): boolean {
  // Strip fenced code blocks first — same as server parser.
  const stripped = content.replace(/```[\s\S]*?```/g, '');
  for (const rawLine of stripped.split(/\r?\n/)) {
    const leadingWs = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const normalized = rawLine.slice(leadingWs).replace(LEADING_MARKDOWN_MENTION_PREFIX_RE, '');
    if (normalized.startsWith('@') && normalized.length > 1) {
      return true;
    }
  }
  return false;
}

/**
 * F193: Internal post-message dispatcher (no KD-1 guard).
 * Used by both handlePostMessage (with KD-1 guard prepended) and
 * handleCrossPostMessage (cross-thread relay path, bypasses guard
 * because cross_post_message is the legitimate cross-thread tool).
 */
async function _executePostMessage(input: {
  content: string;
  threadId?: string | undefined;
  replyTo?: string | undefined;
  clientMessageId?: string | undefined;
  targetCats?: string[] | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  // F174 Phase E (AC-E2/E5): explicit kind:'none' policy. There's no useful
  // local fallback for post_message — losing the message is preferable to
  // re-creating server state on a stale invocation. Cats see the structured
  // `[degrade] reason=...` hint and the existing @mention-textual workaround.
  const result = await withDegradation({
    toolName: 'post_message',
    primary: () =>
      callbackPost(
        '/api/callbacks/post-message',
        {
          content: input.content,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          clientMessageId: input.clientMessageId ?? randomUUID(),
          ...(input.targetCats?.length ? { targetCats: input.targetCats } : {}),
        },
        { enableOutbox: true, agentKeyCatId: input.agentKeyCatId },
      ),
    policy: { kind: 'none' },
  });

  // Detect stale_ignored: server returned 200 but message was NOT delivered
  // because a newer invocation for the same thread+cat has superseded this one.
  // The CLI must know this so it doesn't assume the message reached the user.
  if (!result.isError) {
    try {
      const data = JSON.parse((result.content[0] as { text: string }).text);
      if (data?.status === 'stale_ignored') {
        return errorResult(
          'Message was NOT delivered: this invocation has been superseded by a newer one for the same thread. ' +
            'Your message was silently discarded by the server (stale_ignored). ' +
            'Include the message content in your stdout response instead.',
        );
      }
    } catch {
      // parse failure is fine — means result is not a stale_ignored response
    }
  }

  // If post-message failed and content contains @mentions,
  // hint that text-based @mention is always available.
  // F174 Phase A: route on the structured reason tag (added by callback-retry)
  // instead of regex-matching prose. Falls back to "generic failure" hint when
  // no reason tag is present (e.g. network error, non-auth 4xx).
  if (result.isError && /[@＠]/.test(input.content)) {
    const original = (result.content[0] as { text: string }).text;
    const reason = parseAuthFailureReason(original);
    const reasonHint = ((): string => {
      if (reason === 'expired' || reason === 'unknown_invocation') {
        return '这次 callback 凭证已过期或对应的 invocation 已不在 registry（可能 API 重启过）。';
      }
      if (reason === 'invalid_token') {
        return '这次 callback token 与 invocation 不匹配（客户端可能传错了凭证）。';
      }
      if (reason === 'missing_creds') {
        return '这次 callback 缺少凭证 header（MCP 客户端环境变量可能没注入）。';
      }
      return '这次 post-message 调用失败。';
    })();
    const hint =
      `\n\n💡 Tip: ${reasonHint}如果你想 @其他猫猫，` +
      '不需要用这个 MCP tool——直接在你的回复文本里另起一行写 @猫名 即可' +
      '（例如另起一行写 @缅因猫），系统会自动检测并触发。';
    return errorResult(original + hint);
  }

  return result;
}

/**
 * F193 AC-A2 / KD-1 enforcement at MCP handler layer.
 * Invocation-token caller MUST omit threadId — F043 #316 防误投 contract.
 * Cross-thread delivery only via cat_cafe_cross_post_message.
 * Agent-key caller (F178) is exempt: they REQUIRE threadId since persistent
 * agents have no default thread context.
 *
 * Principal detection MUST follow buildAuthHeaders precedence (line 122):
 * if BOTH CAT_CAFE_INVOCATION_ID and CAT_CAFE_CALLBACK_TOKEN env vars are
 * present, the request will be sent with x-invocation-id headers — regardless
 * of whether the caller passed input.agentKeyCatId. The input field is a
 * sidecar selector for shared Antigravity MCP, NOT an auth principal.
 *
 * Closing砚砚 review P1: previous guard `!input.agentKeyCatId` could be
 * trivially bypassed by an invocation-token caller passing any agentKeyCatId
 * value. The fix gates on the actual auth headers that will be sent.
 */
export async function handlePostMessage(input: {
  content: string;
  threadId?: string | undefined;
  replyTo?: string | undefined;
  clientMessageId?: string | undefined;
  targetCats?: string[] | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  const hasInvocationCreds = !!process.env.CAT_CAFE_INVOCATION_ID && !!process.env.CAT_CAFE_CALLBACK_TOKEN;
  if (input.threadId && hasInvocationCreds) {
    return errorResult(
      'post_message rejects threadId from invocation-token callers (F193 KD-1). ' +
        'For cross-thread delivery, use cat_cafe_cross_post_message(threadId, targetCats, content). ' +
        'For same-thread delivery, omit threadId entirely (defaults to invocation thread).',
    );
  }
  return _executePostMessage(input);
}

export async function handleGetPendingMentions(input: { includeAcked?: boolean | undefined }): Promise<ToolResult> {
  return callbackGet('/api/callbacks/pending-mentions', {
    ...(input.includeAcked ? { includeAcked: '1' } : {}),
  });
}

export async function handleAckMentions(input: { upToMessageId: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/ack-mentions', {
    upToMessageId: input.upToMessageId,
  });
}

export async function handleGetThreadContext(input: {
  limit?: number | undefined;
  threadId?: string | undefined;
  messageId?: string | undefined;
  before?: number | undefined;
  after?: number | undefined;
  catId?: string | undefined;
  keyword?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet(
    '/api/callbacks/thread-context',
    {
      ...(input.limit ? { limit: String(input.limit) } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.before !== undefined ? { before: String(input.before) } : {}),
      ...(input.after !== undefined ? { after: String(input.after) } : {}),
      ...(input.catId ? { catId: input.catId } : {}),
      ...(input.keyword ? { keyword: input.keyword } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

/** #699: Look up a single message by ID with optional surrounding context. */
export async function handleGetMessage(input: {
  messageId: string;
  contextCount?: number | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet(
    '/api/callbacks/get-message',
    {
      messageId: input.messageId,
      ...(input.contextCount ? { contextCount: String(input.contextCount) } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleListThreads(input: {
  limit?: number | undefined;
  activeSince?: number | undefined;
  keyword?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet(
    '/api/callbacks/list-threads',
    {
      ...(input.limit ? { limit: String(input.limit) } : {}),
      ...(input.activeSince !== undefined ? { activeSince: String(input.activeSince) } : {}),
      ...(input.keyword ? { keyword: input.keyword } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleListLabels(input: {
  limit?: number | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet(
    '/api/callbacks/list-labels',
    {
      ...(input.limit ? { limit: String(input.limit) } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleFeatIndex(input: {
  limit?: number | undefined;
  featId?: string | undefined;
  query?: string | undefined;
}): Promise<ToolResult> {
  const result = await callbackGet('/api/callbacks/feat-index', {
    ...(input.limit ? { limit: String(input.limit) } : {}),
    ...(input.featId ? { featId: input.featId } : {}),
    ...(input.query ? { query: input.query } : {}),
  });
  if (result.isError) return result;
  return successResult(formatFeatIndexResponse(result.content[0]?.text ?? '{}'));
}

interface FeatIndexItem {
  featId?: string;
  name?: string;
  status?: string;
  owner?: string;
  ownerCatId?: string;
  keyDecisions?: string[];
  threadIds?: string[];
  suggestedAction?: SuggestedCrossPostAction;
}

function formatFeatIndexResponse(raw: string): string {
  let parsed: { items?: FeatIndexItem[] };
  try {
    parsed = JSON.parse(raw) as { items?: FeatIndexItem[] };
  } catch {
    return raw;
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  if (items.length === 0) return 'feat_index results (0)';

  const lines = [`feat_index results (${items.length})`];
  items.forEach((item, index) => {
    const title = `${item.featId ?? 'unknown'} — ${item.name ?? '(unnamed)'}`;
    lines.push(`${index + 1}. ${title}${item.status ? ` [${item.status}]` : ''}`);
    if (item.owner) {
      lines.push(`   owner: ${item.owner}${item.ownerCatId ? ` (${item.ownerCatId})` : ''}`);
    }
    if (item.keyDecisions?.length) {
      lines.push('   key decisions:');
      item.keyDecisions.forEach((decision) => {
        lines.push(`   - ${decision}`);
      });
    }
    if (item.threadIds?.length) {
      lines.push(`   threads: ${item.threadIds.join(', ')}`);
    }
    const action = item.suggestedAction;
    if (action?.type === 'cross_post') {
      lines.push(...formatSuggestedCrossPostActionLines(action, { indent: '   ', detailIndent: '   ' }));
    }
  });

  return lines.join('\n');
}

export async function handleUpdateTask(input: {
  taskId: string;
  status?: string | undefined;
  why?: string | undefined;
  dispatchGate?: {
    status: 'dispatched' | 'not_dispatched';
    dispatchedThreadId?: string;
    dispatchedMessageId?: string;
    reason?: string;
  };
}): Promise<ToolResult> {
  // F174 Phase E (AC-E2/E5): explicit kind:'none'. Task state lives in Redis;
  // local fallback would diverge from server truth. Surface `[degrade]` hint.
  return withDegradation({
    toolName: 'update_task',
    primary: () =>
      callbackPost('/api/callbacks/update-task', {
        taskId: input.taskId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.why ? { why: input.why } : {}),
        // F193-E1 P1-4: allow patching dispatchGate on existing tasks
        ...(input.dispatchGate ? { dispatchGate: { ...input.dispatchGate, decidedAt: Date.now() } } : {}),
      }),
    policy: { kind: 'none' },
  });
}

export async function handleCreateTask(input: {
  title: string;
  why?: string | undefined;
  ownerCatId?: string | undefined;
  relatedFeatureId?: string | undefined;
  currentFeatureId?: string | undefined;
  dispatchGate?: {
    status: 'dispatched' | 'not_dispatched';
    dispatchedThreadId?: string;
    dispatchedMessageId?: string;
    reason?: string;
  };
}): Promise<ToolResult> {
  // F193-E1: dispatch gate logic
  const textForExtraction = `${input.title} ${input.why ?? ''}`;
  const detectedFIds = extractFeatureIds(textForExtraction);
  const allFIds = input.relatedFeatureId ? [...new Set([input.relatedFeatureId, ...detectedFIds])] : detectedFIds;
  const externalFIds = input.currentFeatureId ? allFIds.filter((f) => f !== input.currentFeatureId) : allFIds; // no currentFeatureId → all detected F-IDs are potentially external

  // Compute persisted dispatch gate state
  let computedGate: DispatchGateState | undefined;
  if (externalFIds.length > 0) {
    if (input.dispatchGate) {
      computedGate = {
        status: input.dispatchGate.status,
        ...(input.dispatchGate.dispatchedThreadId ? { dispatchedThreadId: input.dispatchGate.dispatchedThreadId } : {}),
        ...(input.dispatchGate.dispatchedMessageId
          ? { dispatchedMessageId: input.dispatchGate.dispatchedMessageId }
          : {}),
        ...(input.dispatchGate.reason ? { reason: input.dispatchGate.reason } : {}),
        decidedAt: Date.now(),
      };
    } else {
      // Gate missing — persist status:'missing' so list_tasks can highlight later
      computedGate = {
        status: 'missing',
        suggestedAction: {
          type: 'cross_post',
          featureId: externalFIds[0],
          reason: `Task references ${externalFIds.join(', ')} — consider cross_posting to the owning thread.`,
          source: 'dispatch_gate',
        },
      };
    }
  }

  const result = await callbackPost('/api/callbacks/create-task', {
    title: input.title,
    ...(input.why ? { why: input.why } : {}),
    ...(input.ownerCatId ? { ownerCatId: input.ownerCatId } : {}),
    ...(input.relatedFeatureId ? { relatedFeatureId: input.relatedFeatureId } : {}),
    ...(detectedFIds.length > 0 ? { detectedFeatureIds: detectedFIds } : {}),
    ...(computedGate ? { dispatchGate: computedGate } : {}),
  });

  // Append dispatch gate warning to successful result
  if (computedGate?.status === 'missing' && !result.isError) {
    const warningText =
      `\n\n⚠️ DISPATCH GATE: This task references ${externalFIds.join(', ')} ` +
      `but no dispatch decision was provided. Did you cross_post_message to the ` +
      `${externalFIds[0]} thread? If so, call update_task with dispatchGate: ` +
      `{ status: "dispatched", dispatchedThreadId: "<threadId>", dispatchedMessageId: "<msgId>" }. ` +
      `If not, consider dispatching — the info may be stuck in your thread's local TODO.`;
    const existingText = result.content[0]?.text ?? '';
    return { content: [{ type: 'text', text: existingText + warningText }] };
  }

  return result;
}

export async function handleCrossPostMessage(input: {
  threadId: string;
  content: string;
  targetCats?: string[] | undefined;
  replyTo?: string | undefined;
  clientMessageId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  // F193 AC-A4 closing砚砚 review P1: MCP layer fail-closed.
  // The API route layer (callbacks.ts) only triggers AC-A4 reject when
  // isCrossThread === true (effectiveThreadId !== actor.threadId), which is
  // false for agent-key callers (target-thread write, no source thread).
  // So MUST close routing-creds gate at MCP layer too — covers ALL callers
  // (invocation-token + agent-key) before any HTTP dispatch.
  const hasTargetCats = !!input.targetCats?.length;
  // Line-start @ detection MUST mirror the authoritative server parser
  // (a2a-mentions.ts:107-113): strip code fences, then for each line,
  // trim leading whitespace + strip markdown prefix (`- ` / `> ` / `* ` /
  // `1. ` etc.) and check if it starts with '@'. Closing 砚砚 review round 2
  // P1: a naive /^@\w/m would (a) reject markdown-prefixed routing
  // (`- @codex` / `> @codex`) — which the server parser and SystemPromptBuilder
  // both treat as legitimate — and (b) reject non-ASCII handles like `@缅因猫`
  // (\w only matches [a-zA-Z0-9_]). Server-side analyzeA2AMentions remains
  // the authoritative parser — this is just an early reject for client
  // ergonomics + closing the agent-key API-layer gap.
  const hasLineStartMention = hasPlausibleLineStartMention(input.content);
  if (!hasTargetCats && !hasLineStartMention) {
    return errorResult(
      'cross_post_message requires routing credentials (F193 AC-A4). ' +
        'Pass targetCats: ["catHandle"] OR add a line-start @catHandle in content. ' +
        'Without routing, the cross-thread message would land in the target thread but trigger no cat session.',
    );
  }
  // cross_post_message is the legitimate cross-thread tool — bypass
  // handlePostMessage's KD-1 guard (which is meant to redirect invocation-token
  // callers AWAY from threadId on post_message). Reuse the same delivery
  // primitive via _executePostMessage to share stale_ignored detection,
  // outbox, and degradation hints.
  return _executePostMessage({
    threadId: input.threadId,
    content: input.content,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.agentKeyCatId ? { agentKeyCatId: input.agentKeyCatId } : {}),
    ...(input.targetCats?.length ? { targetCats: input.targetCats } : {}),
  });
}

export async function handleListTasks(input: {
  threadId?: string | undefined;
  catId?: string | undefined;
  status?: 'todo' | 'doing' | 'blocked' | 'done' | undefined;
  kind?: 'work' | 'pr_tracking' | undefined;
}): Promise<ToolResult> {
  return callbackGet('/api/callbacks/list-tasks', {
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.catId ? { catId: input.catId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  });
}

/** F22+F96: Create a rich block (card, diff, checklist, media_gallery, audio, interactive) in the current message */
export const createRichBlockInputSchema = {
  block: z
    .string()
    .min(1)
    .describe('JSON string of the rich block object. Must include id, kind, v:1, and kind-specific fields.'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Target thread ID. Required for agent-key auth because persistent MCP has no invocation thread.'),
  agentKeyCatId: agentKeyCatIdSchema,
};

/**
 * #84: Route A → Route B fallback for rich block creation.
 *
 * F174 Phase E refactor: the typed-reason auth path (expired /
 * unknown_invocation) now flows through `withDegradation` framework so
 * other write-class tools can declare the same policy uniformly. The
 * legacy 403 / "not configured" path predates Phase A typed reasons and
 * stays inline (preserves pre-Phase-A behavior, marks DEGRADED:true).
 */
export async function handleCreateRichBlock(input: {
  block: string;
  threadId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.block);
  } catch {
    return errorResult('Invalid JSON in block parameter');
  }

  // #85 M2c: normalize before validation (type→kind, auto v:1)
  parsed = normalizeRichBlock(parsed);

  if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('kind' in parsed)) {
    return errorResult('Block must include id and kind fields');
  }
  if (!isValidRichBlock(parsed)) {
    return errorResult('Invalid rich block: block does not match required fields for its kind');
  }
  const block = parsed;
  const hasInvocationCreds = !!process.env.CAT_CAFE_INVOCATION_ID && !!process.env.CAT_CAFE_CALLBACK_TOKEN;
  const hasAgentKeyCreds = !!(
    process.env.CAT_CAFE_AGENT_KEY_SECRET ||
    process.env.CAT_CAFE_AGENT_KEY_FILE ||
    process.env.CAT_CAFE_AGENT_KEY_FILES
  );

  const ccRichText = `\`\`\`cc_rich\n${JSON.stringify({ v: 1, blocks: [block] })}\n\`\`\``;
  const runRouteB = async (meta: { route: string; degraded: boolean }): Promise<ToolResult> => {
    const fallback = await handlePostMessage({
      content: ccRichText,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      clientMessageId: randomUUID(),
      agentKeyCatId: input.agentKeyCatId,
    });
    if (!fallback.isError) {
      // Cloud Codex P2 (PR #1384): legacy 403/not-configured branch returns
      // runRouteB() from primary, where the framework treats it as primary
      // success and skips DEGRADED:true tagging. Mark inline so both paths
      // (legacy + framework custom degrade) get consistent telemetry. The
      // framework's markDegraded is idempotent so re-tagging on the custom
      // path is harmless.
      return successResult(
        JSON.stringify({
          status: 'ok',
          route: meta.route,
          ...(meta.degraded ? { DEGRADED: true } : {}),
        }),
      );
    }
    return errorResult(
      `Rich block creation failed (callback token expired or missing). As a workaround, include this in your message text:\n\n${ccRichText}`,
    );
  };

  if (!hasInvocationCreds && hasAgentKeyCreds) {
    if (!input.threadId) {
      return errorResult('threadId is required for create_rich_block when using agent-key auth.');
    }
    return runRouteB({ route: 'B_agent_key', degraded: false });
  }

  // Phase E: framework handles primary call + auth-degradable fallback.
  // For the legacy 403/not-configured path (pre-Phase-A), inspect the
  // returned error text and route to Route B explicitly — preserves the
  // existing behavior without widening the framework's degradable set
  // (AC-E3: framework triggers only on 401-degradable reasons).
  return withDegradation({
    toolName: 'create_rich_block',
    primary: async () => {
      const result = await callbackPost(
        '/api/callbacks/create-rich-block',
        { block, ...(input.threadId ? { threadId: input.threadId } : {}) },
        { enableOutbox: true, agentKeyCatId: input.agentKeyCatId },
      );
      if (!result.isError) return result;
      const errorText = result.content[0]?.type === 'text' ? result.content[0].text : '';
      const isLegacyConfigFailure = /\(403\)/.test(errorText) || /not configured/i.test(errorText);
      if (isLegacyConfigFailure) return runRouteB({ route: 'B_fallback', degraded: true }); // legacy compat path returns success directly
      return result; // framework continues with auth-reason inspection
    },
    policy: { kind: 'custom', degrade: async () => runRouteB({ route: 'B_fallback', degraded: true }) },
  });
}

/** F088 Phase J2: Generate a document (PDF/DOCX/MD) from Markdown content */
export const generateDocumentInputSchema = {
  markdown: z
    .string()
    .min(1)
    .describe('Full Markdown content for the document. Supports headings, tables, lists, code blocks, etc.'),
  format: z
    .enum(['pdf', 'docx', 'md'])
    .describe('Output format. Recommend "docx" (most compatible). "pdf" needs LaTeX, "md" always works.'),
  baseName: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Display name without extension (e.g. "调研报告", "GTC2026-具身智能调研"). Will appear as filename in IM.',
    ),
};

export async function handleGenerateDocument(input: {
  markdown: string;
  format: string;
  baseName: string;
}): Promise<ToolResult> {
  const result = await callbackPost('/api/callbacks/generate-document', {
    markdown: input.markdown,
    format: input.format,
    baseName: input.baseName,
  });
  return result;
}

export const requestPermissionInputSchema = {
  action: z.string().min(1).describe('The action requiring permission (e.g. "git_commit", "file_delete")'),
  reason: z.string().min(1).describe('Why you need this permission'),
  context: z.string().max(5000).optional().describe('Optional additional context for the request'),
};

export const checkPermissionStatusInputSchema = {
  requestId: z.string().min(1).describe('The requestId returned from a previous request_permission call'),
};

export async function handleRequestPermission(input: {
  action: string;
  reason: string;
  context?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/request-permission', {
    action: input.action,
    reason: input.reason,
    ...(input.context ? { context: input.context } : {}),
  });
}

export async function handleCheckPermissionStatus(input: { requestId: string }): Promise<ToolResult> {
  return callbackGet('/api/callbacks/permission-status', {
    requestId: input.requestId,
  });
}

// TD091: PR tracking registration — server resolves threadId from invocation record
export const registerPrTrackingInputSchema = {
  repoFullName: z.string().min(1).describe('Repository full name in owner/repo format (e.g. "zts212653/cat-cafe")'),
  prNumber: z.number().int().positive().describe('PR number'),
  // F202 Phase 2C (AC-C1): tracking instructions appended to trigger messages
  instructions: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Tracking instructions — appended to trigger messages when review/CI events fire. Task preference, not system override.',
    ),
  catId: z
    .string()
    .optional()
    .describe('Deprecated — server auto-resolves from invocation identity. Ignored if provided.'),
  intent: z
    .enum(['review', 'merge'])
    .optional()
    .describe(
      "Wake intent for this PR. 'review' (default) = you're waiting on review feedback → CI-pass " +
        "stays silent (you'll see it when you look). 'merge' = you're waiting on CI-green to merge " +
        '(your approved PR / an outbound PR / owner-merging someone else’s PR) → CI-pass wakes you. ' +
        'Re-call this tool to flip the intent (e.g. switch to "merge" once review is approved).',
    ),
};

export async function handleRegisterPrTracking(input: {
  repoFullName: string;
  prNumber: number;
  instructions?: string;
  catId?: string;
  intent?: 'review' | 'merge';
}): Promise<ToolResult> {
  // F174 Phase E (AC-E2/E5): explicit kind:'none'. PR tracking is one-shot
  // registration, no useful local fallback. Surface `[degrade]` hint.
  return withDegradation({
    toolName: 'register_pr_tracking',
    primary: () =>
      callbackPost('/api/callbacks/register-pr-tracking', {
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.catId ? { catId: input.catId } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
      }),
    policy: { kind: 'none' },
  });
}

// F202 Phase 2D (AC-D3): Register issue tracking
export const registerIssueTrackingInputSchema = {
  repoFullName: z.string().min(1).describe('Repository full name in owner/repo format (e.g. "zts212653/cat-cafe")'),
  issueNumber: z.number().int().positive().describe('Issue number'),
  instructions: z
    .string()
    .max(2000)
    .optional()
    .describe('Tracking instructions — appended to trigger messages when issue comment events fire.'),
};

export async function handleRegisterIssueTracking(input: {
  repoFullName: string;
  issueNumber: number;
  instructions?: string;
}): Promise<ToolResult> {
  return withDegradation({
    toolName: 'register_issue_tracking',
    primary: () =>
      callbackPost('/api/callbacks/register-issue-tracking', {
        repoFullName: input.repoFullName,
        issueNumber: input.issueNumber,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      }),
    policy: { kind: 'none' },
  });
}

// F202 Phase 2C (AC-C3): Unregister tracking task by subjectKey
export const unregisterTrackingInputSchema = {
  subjectKey: z
    .string()
    .min(1)
    .describe('Subject key to unregister. Format: "pr:{owner/repo}#{num}" or "issue:{owner/repo}#{num}"'),
};

export async function handleUnregisterTracking(input: { subjectKey: string }): Promise<ToolResult> {
  return withDegradation({
    toolName: 'unregister_tracking',
    primary: () =>
      callbackPost('/api/callbacks/unregister-tracking', {
        subjectKey: input.subjectKey,
      }),
    policy: { kind: 'none' },
  });
}

// F168 Phase B Task 6: Declare awaiting_external state for a community case
export const communityAwaitExternalInputSchema = {
  subjectKey: z
    .string()
    .min(1)
    .describe(
      'Community case subject key. Format: "issue:{owner/repo}#{number}" or "pr:{owner/repo}#{number}". ' +
        'Example: "issue:my-org/my-repo#42".',
    ),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Optional free-text reason describing what you are waiting for (e.g. "waiting for reporter to provide reproduction steps").',
    ),
};

/**
 * Declare that the owner (you) is waiting for an external response on a community case.
 *
 * WHEN TO USE: After responding to an issue/PR and explicitly waiting for the reporter or
 * external contributor to reply. While in awaiting_external state:
 *  - Maintainer (OWNER/MEMBER) activity on the case is silently logged — no wake notification.
 *  - External actor (reporter, contributor) activity automatically restores the case to
 *    in_progress and sends you a wake notification.
 *
 * EFFECT: Appends case.awaiting_external to the community event log and updates the
 * projection so the community board shows the correct state.
 */
export async function handleCommunityAwaitExternal(input: {
  subjectKey: string;
  reason?: string;
}): Promise<ToolResult> {
  // URL-encode subjectKey so the colon, slashes, and hash are safe in the path segment
  const encodedKey = encodeURIComponent(input.subjectKey);
  return withDegradation({
    toolName: 'community_await_external',
    primary: () =>
      callbackPost(`/api/community-issues/${encodedKey}/await-external`, {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      }),
    policy: { kind: 'none' },
  });
}

export const updateWorkflowInputSchema = {
  backlogItemId: z.string().min(1).describe('The backlog item ID to update workflow SOP for'),
  featureId: z.string().min(1).describe('Feature ID (e.g. "F073")'),
  sopDefinitionId: z
    .enum(SOP_DEFINITION_IDS)
    .optional()
    .describe('SOP definition id. Defaults to "development" for existing workflows.'),
  stage: z.enum(DEVELOPMENT_SOP_STAGE_IDS).optional().describe('Current SOP stage'),
  batonHolder: z
    .string()
    .min(1)
    .optional()
    .describe('Unique handle of the cat currently holding the baton (a valid registered catId)'),
  nextSkill: z
    .string()
    .nullable()
    .optional()
    .describe('Suggested skill to load next (e.g. "tdd", "quality-gate"), or null'),
  resumeCapsule: z
    .object({
      goal: z.string().optional().describe('What we are building'),
      done: z.array(z.string()).optional().describe('What has been completed'),
      currentFocus: z.string().optional().describe('What we are working on right now'),
    })
    .optional()
    .describe('Resume capsule for cold start / context recovery'),
  checks: z
    .object({
      remoteMainSynced: z.enum(['attested', 'verified', 'unknown']).optional(),
      qualityGatePassed: z.enum(['attested', 'verified', 'unknown']).optional(),
      reviewApproved: z.enum(['attested', 'verified', 'unknown']).optional(),
      visionGuardDone: z.enum(['attested', 'verified', 'unknown']).optional(),
    })
    .optional()
    .describe('SOP checkpoint attestations'),
  expectedVersion: z
    .number()
    .int()
    .optional()
    .describe('CAS: reject if current version does not match (for concurrent update safety)'),
};

export async function handleUpdateWorkflow(input: {
  backlogItemId: string;
  featureId: string;
  sopDefinitionId?: string | undefined;
  stage?: string | undefined;
  batonHolder?: string | undefined;
  nextSkill?: string | null | undefined;
  resumeCapsule?: { goal?: string; done?: string[]; currentFocus?: string } | undefined;
  checks?:
    | {
        remoteMainSynced?: string;
        qualityGatePassed?: string;
        reviewApproved?: string;
        visionGuardDone?: string;
      }
    | undefined;
  expectedVersion?: number | undefined;
}): Promise<ToolResult> {
  const body: Record<string, unknown> = {
    backlogItemId: input.backlogItemId,
    featureId: input.featureId,
  };
  if (input.sopDefinitionId !== undefined) body.sopDefinitionId = input.sopDefinitionId;
  if (input.stage !== undefined) body.stage = input.stage;
  if (input.batonHolder !== undefined) body.batonHolder = input.batonHolder;
  if (input.nextSkill !== undefined) body.nextSkill = input.nextSkill;
  if (input.resumeCapsule !== undefined) body.resumeCapsule = input.resumeCapsule;
  if (input.checks !== undefined) body.checks = input.checks;
  if (input.expectedVersion !== undefined) body.expectedVersion = input.expectedVersion;
  return callbackPost('/api/callbacks/update-workflow-sop', body);
}

// ============ Multi-Mention (F086) ============

export const multiMentionInputSchema = {
  targets: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .describe(
      'Cat IDs to invoke in parallel (max 3). Use get_thread_cats to discover valid catIds. ' +
        'F182: if any target is disabled, returns 400 {kind:"cat_disabled", catId, alternatives[]}. ' +
        'Retry with available cats from alternatives[] — do NOT retry the same disabled cat.',
    ),
  question: z.string().min(1).max(5000).describe('The question or request for the target cats'),
  callbackTo: z
    .string()
    .min(1)
    .describe(
      'Cat ID to route all responses back to (required, usually yourself). ' +
        'F182: if disabled, returns 400 {kind:"cat_disabled", alternatives[]}. Use an available cat from alternatives[].',
    ),
  context: z.string().max(5000).optional().describe('Additional context to include for the targets'),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Idempotency key to prevent duplicate dispatches within the same thread'),
  timeoutMinutes: z.number().int().min(3).max(20).optional().describe('Timeout in minutes (default 8, range 3-20)'),
  searchEvidenceRefs: z
    .array(z.string())
    .optional()
    .describe(
      'References to searches you performed before calling this tool (required unless overrideReason provided). Enforces "先搜后问" principle.',
    ),
  overrideReason: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Why you are skipping search evidence (required if searchEvidenceRefs omitted)'),
  triggerType: z
    .enum(['high-impact', 'cross-domain', 'uncertain', 'info-gap', 'recon'])
    .optional()
    .describe('Which meta-thinking trigger motivated this call'),
};

export async function handleMultiMention(input: {
  targets: string[];
  question: string;
  callbackTo: string;
  context?: string | undefined;
  idempotencyKey?: string | undefined;
  timeoutMinutes?: number | undefined;
  searchEvidenceRefs?: string[] | undefined;
  overrideReason?: string | undefined;
  triggerType?: 'high-impact' | 'cross-domain' | 'uncertain' | 'info-gap' | 'recon' | undefined;
}): Promise<ToolResult> {
  // Client-side validation: searchEvidenceRefs or overrideReason required
  if (!input.searchEvidenceRefs?.length && !input.overrideReason) {
    return errorResult(
      'multi_mention requires searchEvidenceRefs (what did you search first?) ' +
        'or overrideReason (why are you skipping search?). ' +
        'This enforces the "先搜后问" principle — search before asking.',
    );
  }

  return callbackPost('/api/callbacks/multi-mention', {
    targets: input.targets,
    question: input.question,
    callbackTo: input.callbackTo,
    ...(input.context ? { context: input.context } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.timeoutMinutes !== undefined ? { timeoutMinutes: input.timeoutMinutes } : {}),
    ...(input.searchEvidenceRefs ? { searchEvidenceRefs: input.searchEvidenceRefs } : {}),
    ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    ...(input.triggerType ? { triggerType: input.triggerType } : {}),
  });
}

// F079 Gap 4: Cat-initiated voting
export const startVoteInputSchema = {
  question: z.string().min(1).max(500).describe('The voting question'),
  options: z.array(z.string().min(1).max(100)).min(2).max(20).describe('Voting options (at least 2)'),
  voters: z
    .array(z.string().min(1).max(50))
    .min(1)
    .max(20)
    .describe(
      'CatIds of voters. Use get_thread_cats to discover valid catIds. ' +
        'F182: if any voter is disabled, returns 400 {kind:"cat_disabled", catId, alternatives[]}. ' +
        'Replace the disabled voter with an available cat from alternatives[].',
    ),
  anonymous: z.boolean().optional().describe('Anonymous voting (default: false)'),
  timeoutSec: z.number().int().min(10).max(600).optional().describe('Timeout in seconds (default: 120)'),
};

export async function handleStartVote(input: {
  question: string;
  options: string[];
  voters: string[];
  anonymous?: boolean | undefined;
  timeoutSec?: number | undefined;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/start-vote', {
    question: input.question,
    options: input.options,
    voters: input.voters,
    ...(input.anonymous !== undefined ? { anonymous: input.anonymous } : {}),
    ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
  });
}

// ============ Bootcamp (F087) ============

export const updateBootcampStateInputSchema = {
  threadId: z.string().min(1).describe('Thread ID of the bootcamp thread'),
  phase: z
    .enum([
      'phase-1-intro',
      'phase-2-env-check',
      'phase-3-config-help',
      'phase-4-task-select',
      'phase-5-kickoff',
      'phase-6-design',
      'phase-7-dev',
      'phase-7.5-add-teammate',
      'phase-8-collab',
      'phase-9-complete',
      'phase-10-retro',
      'phase-11-farewell',
    ])
    .optional()
    .describe('New bootcamp phase to advance to'),
  leadCat: z.string().optional().describe('Selected lead cat ID (a valid registered catId)'),
  selectedTaskId: z.string().max(50).optional().describe('Selected task ID (e.g. "Q1", "Q7")'),
  envCheck: z
    .record(z.object({ ok: z.boolean(), version: z.string().optional(), note: z.string().optional() }))
    .optional()
    .describe('Environment check results (usually auto-set by bootcamp-env-check)'),
  advancedFeatures: z
    .record(z.enum(['available', 'unavailable', 'skipped']))
    .optional()
    .describe('Advanced feature status: TTS, ASR, Pencil'),
  guideStep: z
    .enum(['open-hub', 'click-add-member', 'fill-form', 'mention-teammate', 'return-to-chat', 'done'])
    .nullable()
    .optional()
    .describe(
      'Sub-step for the add-teammate guide overlay. Set to "open-hub" when advancing to phase-7.5-add-teammate. Set to null to clear.',
    ),
  completedAt: z.number().optional().describe('Timestamp when bootcamp was completed (Phase 11)'),
};

export async function handleUpdateBootcampState(input: {
  threadId: string;
  phase?: string | undefined;
  leadCat?: string | undefined;
  selectedTaskId?: string | undefined;
  envCheck?: Record<string, { ok: boolean; version?: string; note?: string }> | undefined;
  advancedFeatures?: Record<string, string> | undefined;
  guideStep?: string | null | undefined;
  completedAt?: number | undefined;
}): Promise<ToolResult> {
  const body: Record<string, unknown> = { threadId: input.threadId };
  if (input.phase !== undefined) body.phase = input.phase;
  if (input.leadCat !== undefined) body.leadCat = input.leadCat;
  if (input.selectedTaskId !== undefined) body.selectedTaskId = input.selectedTaskId;
  if (input.envCheck !== undefined) body.envCheck = input.envCheck;
  if (input.advancedFeatures !== undefined) body.advancedFeatures = input.advancedFeatures;
  if (input.guideStep !== undefined) body.guideStep = input.guideStep;
  if (input.completedAt !== undefined) body.completedAt = input.completedAt;
  return callbackPost('/api/callbacks/update-bootcamp-state', body);
}

export const bootcampEnvCheckInputSchema = {
  threadId: z.string().min(1).describe('Thread ID — results are auto-stored in bootcampState.envCheck'),
};

export async function handleBootcampEnvCheck(input: { threadId: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/bootcamp-env-check', { threadId: input.threadId });
}

// ============ Propose Thread (F128) ============

export const proposeThreadInputSchema = {
  title: z.string().min(1).max(200).describe('Title for the proposed thread (user can edit before approving)'),
  reason: z.string().min(1).max(1000).describe('Why a new thread is needed (shown to the user on the proposal card)'),
  preferredCats: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('Optional cat IDs to preselect for the new thread (e.g. ["codex","gemini"])'),
  initialMessage: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'Optional first message body posted as the source cat (AC-AA4 source attribution) into the new thread on approve. Server injects routing credentials (threadId + @handle) into the header so downstream cats can cross-post back.',
    ),
  reportingMode: z
    .enum(['none', 'final-only', 'state-transitions', 'blocking-ack'])
    .optional()
    .describe(
      'Optional F128 reporting contract for the sub-thread (AC-AA1: default is final-only). final-only (default): report a summary once on completion via cross_post with routing credentials. none (autonomous): downstream self-governs, no required report-back (only escalate operator/blocker/irreversible/cross-feature conflict per house rules). state-transitions: report at each phase boundary. blocking-ack: wait for source-thread ack at each blocker. Triage/dispatch → none; fork-and-return needing a summary → final-only.',
    ),
  parentThreadId: z.string().min(1).optional().describe('Optional parent thread ID. Defaults to the current thread.'),
  projectPath: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Optional absolute project directory the child thread belongs to (e.g. "/home/user/clowder-ai"). This decides the working directory cats use when invoked in the new thread. Omit to inherit THIS thread\'s project; if THIS thread is default/未分类/eval/lobby and the child will do repo or implementation work, set projectPath explicitly. Invalid/non-existent paths are rejected (400), never silently defaulted. The user can also change it on the approval card.',
    ),
  clientRequestId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key. Resending with the same value returns the same proposalId.'),
};

export async function handleProposeThread(input: {
  title: string;
  reason: string;
  preferredCats?: string[] | undefined;
  initialMessage?: string | undefined;
  reportingMode?: 'none' | 'final-only' | 'state-transitions' | 'blocking-ack' | undefined;
  parentThreadId?: string | undefined;
  projectPath?: string | undefined;
  clientRequestId?: string | undefined;
}): Promise<ToolResult> {
  // P2-1: always send an idempotency key — auto-generate when the caller didn't supply one,
  // so transient network retries from callbackPost never produce duplicate proposals.
  const body: Record<string, unknown> = {
    title: input.title,
    reason: input.reason,
    clientRequestId: input.clientRequestId ?? randomUUID(),
  };
  if (input.preferredCats?.length) body.preferredCats = input.preferredCats;
  if (input.initialMessage) body.initialMessage = input.initialMessage;
  if (input.reportingMode) body.reportingMode = input.reportingMode;
  if (input.parentThreadId) body.parentThreadId = input.parentThreadId;
  if (input.projectPath) body.projectPath = input.projectPath;

  const result = await callbackPost('/api/callbacks/propose-thread', body);
  if (!result.isError) {
    try {
      const data = JSON.parse((result.content[0] as { text: string }).text);
      if (data?.status === 'stale_ignored') {
        return errorResult(
          'Proposal was NOT created: this invocation has been superseded by a newer one (stale_ignored).',
        );
      }
    } catch {
      // parse failure is fine
    }
  }
  return result;
}

// ============ F225: Cat-Initiated Session Handoff ============

export const proposeSessionHandoffInputSchema = {
  done: z
    .string()
    .min(1)
    .max(2000)
    .describe('五件套·已完成：这个 session 你做完了什么（让续接的你一眼看清进展，别重新摸索）'),
  nextSteps: z.string().min(1).max(2000).describe('五件套·下一步：续接的你从哪里继续、第一步具体做什么'),
  worktreeBranch: z
    .string()
    .max(200)
    .optional()
    .describe('五件套·worktree/分支（可选）：当前工作的 worktree 路径或分支名'),
  commits: z
    .array(z.string().min(1).max(100))
    .max(50)
    .optional()
    .describe('五件套·commits（可选）：相关 commit SHA 列表'),
  gotchas: z
    .string()
    .max(2000)
    .optional()
    .describe('五件套·坑/注意（可选）：续接的你最容易踩的坑、不可逆点、待验证假设'),
  clientRequestId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key. Resending with the same value returns the same proposalId.'),
};

export async function handleProposeSessionHandoff(input: {
  done: string;
  nextSteps: string;
  worktreeBranch?: string | undefined;
  commits?: string[] | undefined;
  gotchas?: string | undefined;
  clientRequestId?: string | undefined;
}): Promise<ToolResult> {
  // P2 (云端): always send an idempotency key — auto-generate when the caller didn't supply one —
  // so callbackPost transport retries (408/429/5xx) resolve back to the original proposal instead of
  // tripping the A4 ≤1-pending gate and misreporting "NOT created" (mirrors F128 handleProposeThread).
  const body: Record<string, unknown> = {
    done: input.done,
    nextSteps: input.nextSteps,
    clientRequestId: input.clientRequestId ?? randomUUID(),
  };
  if (input.worktreeBranch) body.worktreeBranch = input.worktreeBranch;
  if (input.commits?.length) body.commits = input.commits;
  if (input.gotchas) body.gotchas = input.gotchas;

  const result = await callbackPost('/api/callbacks/propose-session-handoff', body);
  if (!result.isError) {
    try {
      const data = JSON.parse((result.content[0] as { text: string }).text);
      if (data?.status === 'stale_ignored') {
        return errorResult(
          'Handoff proposal NOT created: this invocation was superseded by a newer one (stale_ignored).',
        );
      }
      if (data?.status === 'rejected') {
        // A4 gate / no-active-session — surface the reason so the cat reacts instead of retry-spamming.
        return errorResult(`Handoff proposal NOT created (${data.reason}): ${data.message ?? ''}`);
      }
    } catch {
      // parse failure is fine
    }
  }
  return result;
}

// ============ F231 Phase C: Propose Profile Update ============

export const proposeProfileUpdateInputSchema = {
  afterContent: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      'The COMPLETE new primer content (whole-file replacement, NOT a diff/patch). On approval the server writes this verbatim into relationship/{yourCatId}-primer.md. Include everything you want kept — anything you omit is dropped.',
    ),
  rationale: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      'Why this update — shown to the operator on the confirmation card (e.g. "co-creator说更喜欢先给结论再展开，固化沟通偏好"). Be specific so the operator can judge the change at a glance.',
    ),
  signalKind: z
    .enum(['cat-declared', 'cvo-instructed'])
    .describe(
      "Where the relationship signal came from (provenance). 'cat-declared' = you observed/inferred it from the interaction; 'cvo-instructed' = the operator explicitly asked you to remember it. AC-C1 is manual-entry only (no auto-classifier).",
    ),
  sourceMessageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional message ID that triggered this update (provenance trail — lets the audit log trace back to the exact message).',
    ),
  clientRequestId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key. Resending with the same value returns the same proposalId.'),
};

export async function handleProposeProfileUpdate(input: {
  afterContent: string;
  rationale: string;
  signalKind: 'cat-declared' | 'cvo-instructed';
  sourceMessageId?: string | undefined;
  clientRequestId?: string | undefined;
}): Promise<ToolResult> {
  // Always send an idempotency key — auto-generate when the caller didn't supply one, so transient
  // callbackPost retries never produce duplicate proposals (mirrors F128 handleProposeThread).
  const body: Record<string, unknown> = {
    afterContent: input.afterContent,
    rationale: input.rationale,
    signalKind: input.signalKind,
    clientRequestId: input.clientRequestId ?? randomUUID(),
  };
  if (input.sourceMessageId) body.sourceMessageId = input.sourceMessageId;

  const result = await callbackPost('/api/callbacks/propose-profile-update', body);
  if (!result.isError) {
    try {
      const data = JSON.parse((result.content[0] as { text: string }).text);
      if (data?.status === 'stale_ignored') {
        return errorResult(
          'Profile-update proposal was NOT created: this invocation has been superseded by a newer one (stale_ignored).',
        );
      }
    } catch {
      // parse failure is fine
    }
  }
  return result;
}

// ============ Thread Cats Discovery ============

export const getThreadCatsInputSchema = {};

export async function handleGetThreadCats(): Promise<ToolResult> {
  return callbackGet('/api/callbacks/thread-cats');
}

// F155: Guide Engine

export const updateGuideStateInputSchema = {
  threadId: z.string().min(1).describe('Thread ID where the guide is being offered/active'),
  guideId: z.string().min(1).describe('Guide ID (e.g. "add-member")'),
  status: z
    .enum(['offered', 'awaiting_choice', 'completed', 'cancelled'])
    .describe(
      'Target guide status. Valid transitions: offered→awaiting_choice/cancelled, awaiting_choice→cancelled, active→completed/cancelled. Use cat_cafe_start_guide for →active.',
    ),
  currentStep: z.number().int().min(0).optional().describe('Current step index (only when status=active)'),
};

export async function handleUpdateGuideState(input: {
  threadId: string;
  guideId: string;
  status: string;
  currentStep?: number | undefined;
}): Promise<ToolResult> {
  const body: Record<string, unknown> = { threadId: input.threadId, guideId: input.guideId, status: input.status };
  if (input.currentStep !== undefined) body.currentStep = input.currentStep;
  return callbackPost('/api/callbacks/update-guide-state', body);
}

export async function handleStartGuide(input: { guideId: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/start-guide', { guideId: input.guideId });
}

export const getAvailableGuidesInputSchema = {};

export async function handleGetAvailableGuides(): Promise<ToolResult> {
  return callbackPost('/api/callbacks/get-available-guides', {});
}

// F193 Phase D AC-D2: handleGuideResolve removed — legacy alias replaced
// by cat_cafe_get_available_guides, which lets the cat inspect catalog
// metadata directly instead of guessing from a single intent string.

export async function handleGuideControl(input: { action: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/guide-control', { action: input.action });
}

export async function handleHoldBall(input: {
  reason: string;
  nextStep: string;
  wakeAfterMs: number;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/hold-ball', {
    reason: input.reason,
    nextStep: input.nextStep,
    wakeAfterMs: input.wakeAfterMs,
  });
}

export const callbackTools = [
  {
    name: 'cat_cafe_post_message',
    description:
      'Post a proactive async message to YOUR CURRENT thread mid-task (e.g. progress updates, sharing results). ' +
      'Always posts to the thread your invocation belongs to. To post to a DIFFERENT thread, use cat_cafe_cross_post_message instead. ' +
      'To hand off to another cat, write @猫名 on its own line at the START of the line (sentence-internal @mention does NOT route — it is treated as narrative only). ' +
      'Output: message appears in your current thread as a new message (separate from your invocation response). ' +
      'GOTCHA: This tool uses callback credentials that expire — if it fails with 401, fall back to line-start @mention in your response text. ' +
      'GOTCHA: Do NOT use this for routine replies — only for mid-task proactive messages when you need to share something before your response completes.',
    inputSchema: postMessageInputSchema,
    handler: handlePostMessage,
  },
  {
    name: 'cat_cafe_get_pending_mentions',
    description:
      'Get recent messages that @-mention you. Use at session start to check if anyone is trying to get your attention. ' +
      'TIP: Call this early in your session, then call ack_mentions after processing to avoid seeing the same mentions next session.',
    inputSchema: getPendingMentionsInputSchema,
    handler: handleGetPendingMentions,
  },
  {
    name: 'cat_cafe_ack_mentions',
    description:
      'Acknowledge that you have processed mentions up to a specific message ID. ' +
      'Call this AFTER processing mentions from get_pending_mentions to avoid seeing them again in future sessions. ' +
      'GOTCHA: Pass the message ID of the LAST mention you processed, not the first.',
    inputSchema: ackMentionsInputSchema,
    handler: handleAckMentions,
  },
  {
    name: 'cat_cafe_get_thread_context',
    description:
      'READ raw messages from a thread. Use to understand what has been discussed recently. ' +
      'Pass threadId to read a DIFFERENT thread (cross-thread context); omit to read the current thread. ' +
      'Use keyword to find and RANK messages by relevance (multi-word tokenized scoring, results sorted by match quality). ' +
      'BOUNDARY: This tool READS one thread. For FINDING information across all project knowledge (features, decisions, plans, lessons), use search_evidence instead.',
    inputSchema: getThreadContextInputSchema,
    handler: handleGetThreadContext,
  },
  // D15: cat_cafe_search_messages removed — superseded by search_evidence + get_thread_context
  {
    name: 'cat_cafe_get_message',
    description:
      'Look up a single message by its messageId. Use when you receive a message with replyTo — ' +
      'call this to read the original quoted message and its surrounding context. ' +
      'Returns the message content, sender, timestamp, and optionally N nearby messages for context. ' +
      'PARAM GUIDE: messageId = required exact ID. contextCount = number of messages before/after to include (default 0, max 10).',
    inputSchema: {
      messageId: z.string().min(1).describe('The exact message ID to look up'),
      contextCount: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Number of messages before and after to include for context (0-10, default 0)'),
      agentKeyCatId: agentKeyCatIdSchema,
    },
    handler: handleGetMessage,
  },
  {
    name: 'cat_cafe_get_thread_cats',
    description:
      'Discover which cats are in the current thread: participants (with activity stats), routable cats, and availability. ' +
      'Use BEFORE multi_mention / start_vote / @mentions to find valid catIds — do NOT guess catIds from memory. ' +
      'Returns: participants (catId, displayName, lastMessageAt, messageCount), routableNow, routableNotJoined, notRoutable.',
    inputSchema: getThreadCatsInputSchema,
    handler: handleGetThreadCats,
  },
  {
    name: 'cat_cafe_list_threads',
    description:
      'List thread summaries for discovery. Use when you need to find a thread by keyword or see recent activity. ' +
      'Returns thread IDs, titles, and activity timestamps. ' +
      'Use activeSince (Unix ms) to filter to recently active threads. Use keyword to search by title.',
    inputSchema: listThreadsInputSchema,
    handler: handleListThreads,
  },
  {
    name: 'cat_cafe_list_labels',
    description:
      'List user-defined thread labels (id, name, color). Use when you need to know which labels exist ' +
      'before suggesting label assignments for threads. Returns all labels sorted by sortOrder.',
    inputSchema: listLabelsInputSchema,
    handler: handleListLabels,
  },
  {
    name: 'cat_cafe_feat_index',
    description:
      'Lookup feature index entries by featId or query. Returns featId, name, status, and linked threadIds. ' +
      'Use when you need to find which thread(s) a feature is discussed in, or check feature status. ' +
      'PARAM GUIDE: featId = exact match (e.g. "F043"), query = fuzzy substring over all fields.',
    inputSchema: featIndexInputSchema,
    handler: handleFeatIndex,
  },
  {
    name: 'cat_cafe_cross_post_message',
    description:
      'Post a message to a specific thread by threadId (cross-thread notification). ' +
      'Use when you need to notify a different thread about something relevant. ' +
      'NOT for: posting to your own current thread (use post_message instead). ' +
      'Output: message appears in the target thread as a new message visible to all participants. ' +
      'ROUTING: You MUST include routing credentials to wake the target cat — either set `targetCats` array with the recipient catId(s), OR put a line-start `@handle` in content. ' +
      'Messages without routing (no targetCats, no line-start @) will be REJECTED (F193 AC-A4). ' +
      'GOTCHA: Requires threadId — use list_threads or feat_index to find the right thread first. ' +
      'TIP: The sub-thread "## 主 Thread" header includes exact routing credentials (threadId + targetCats/handle) — copy them directly.',
    inputSchema: crossPostMessageInputSchema,
    handler: handleCrossPostMessage,
  },
  {
    name: 'cat_cafe_list_tasks',
    description:
      'List tasks with optional threadId/catId/status filters for global task discovery. ' +
      'Use when you need to see what tasks exist, who owns them, or what is blocked. ' +
      'TIP: Filter by status="blocked" to find tasks that need attention.',
    inputSchema: listTasksInputSchema,
    handler: handleListTasks,
  },
  {
    name: 'cat_cafe_update_task',
    description:
      'Update a task you own: mark as doing/blocked/done, or resolve a missing dispatch gate. ' +
      'GOTCHA: You can only update tasks assigned to you (your catId). ' +
      'TIP: Include a "why" note when marking as blocked — it helps others understand the situation. ' +
      'F193-E1: Pass dispatchGate to resolve a "missing" dispatch gate (e.g. after cross_posting to the owning thread).',
    inputSchema: updateTaskInputSchema,
    handler: handleUpdateTask,
  },
  {
    name: 'cat_cafe_create_task',
    description:
      'Create a new 🧶 毛线球 (yarn ball) task in the current thread. ' +
      'Use when: user says "建个毛线球", "记一下任务", "track this", or you identify persistent work items across sessions — ' +
      'e.g. "fix login timeout", "update API docs", "review F160 spec". ' +
      'NOT for: temporary execution steps (use PlanBoard/TodoWrite), NOT for inline checklists in a message (use create_rich_block with kind:"checklist"). ' +
      'Output: task appears in the thread 🧶 毛线球 panel, persists across sessions, visible to all cats and co-creator. ' +
      'GOTCHA: 毛线球 ≠ checklist rich block. 毛线球 lives in the task panel and survives session boundaries; checklist is ephemeral inline content in one message. ' +
      'TIP: Include a "why" to give context to whoever picks up the task. ' +
      'F193-E1 DISPATCH GATE: If your task references a feature (F-number) outside your current scope, ' +
      'provide dispatchGate with status "dispatched" (you already cross_posted to the owning thread) ' +
      'or "not_dispatched" (with reason). If you omit dispatchGate and external F-IDs are detected, ' +
      'the task is created but a warning is returned reminding you to dispatch.',
    inputSchema: createTaskInputSchema,
    handler: handleCreateTask,
  },
  {
    name: 'cat_cafe_create_rich_block',
    description:
      'Create a rich block (card, diff, checklist, media_gallery, audio, or interactive) attached to the current message. ' +
      'Use card for status/decisions, diff for code changes, checklist for inline todos, media_gallery for images, audio for voice, interactive for user selection/confirmation. ' +
      'Use this for long structured replies/reports with lists, tables, code blocks, diffs, status fields, or multi-step checklists; F192 rich-messaging wakeup treats plain long Markdown with these signals and no rich block as a miss. ' +
      'NOT for: persistent task tracking across sessions (use create_task for 🧶 毛线球). NOT for: document generation/export (use generate_document). ' +
      'Output: block rendered inline in the current message. ' +
      'GOTCHA: The block JSON must use "kind" (NOT "type") and include "v": 1 and a unique "id". ' +
      "GOTCHA: Call get_rich_block_rules first if you haven't loaded the full schema yet in this session. " +
      'GOTCHA: checklist kind is ephemeral inline content — for persistent cross-session work items, use create_task (毛线球) instead. ' +
      'If callback auth fails, falls back to cc_rich text encoding automatically.',
    inputSchema: createRichBlockInputSchema,
    handler: handleCreateRichBlock,
  },
  {
    name: 'cat_cafe_generate_document',
    description:
      'Generate a document (PDF/DOCX/MD) from Markdown and deliver to IM platforms (Feishu/Telegram). ' +
      'Use when: user asks to "生成报告", "导出文档", "发PDF", "写份文档给我", "export to DOCX", or any document generation request. ' +
      'NOT for: sending an existing file you already have (use create_rich_block with kind:"file" + url pointing to /uploads/). ' +
      'Output: file saved to /uploads/, attached as file RichBlock, automatically delivered to bound IM chats. Web UI shows download link. ' +
      'GOTCHA: Do NOT manually run pandoc + create_rich_block — that skips IM delivery and the file will NOT reach Feishu/Telegram. Always use this tool. ' +
      'Degradation: PDF needs LaTeX engine → falls back to DOCX → falls back to MD. No pandoc → .md only.',
    inputSchema: generateDocumentInputSchema,
    handler: handleGenerateDocument,
  },
  {
    name: 'cat_cafe_request_permission',
    description:
      'Request permission from the user before performing a sensitive action (e.g. git_commit, file_delete). ' +
      'Returns granted/denied immediately if a rule exists, or pending with a requestId if the user needs to approve. ' +
      'WORKFLOW: request_permission → if pending → wait → check_permission_status with the returned requestId.',
    inputSchema: requestPermissionInputSchema,
    handler: handleRequestPermission,
  },
  {
    name: 'cat_cafe_check_permission_status',
    description:
      'Check the status of a previously submitted permission request. ' +
      'Use the requestId returned from request_permission. Returns granted/denied/pending.',
    inputSchema: checkPermissionStatusInputSchema,
    handler: handleCheckPermissionStatus,
  },
  {
    name: 'cat_cafe_register_pr_tracking',
    description:
      'Register a PR for review/CI/conflict notification routing. Call right after `gh pr create` ' +
      'so that cloud review feedback, CI status, and merge conflicts route to your current thread. ' +
      'The server resolves threadId and catId from your invocation identity — you only need repoFullName and prNumber. ' +
      "Pass intent='review' (default) when you're waiting on review — CI-pass stays silent; pass intent='merge' " +
      '(or re-call to switch) when you’re waiting on CI-green to merge — then CI-pass wakes you. ' +
      'GOTCHA: Must be called in the same session that created the PR, while callback credentials are still valid.',
    inputSchema: registerPrTrackingInputSchema,
    handler: handleRegisterPrTracking,
  },
  {
    name: 'cat_cafe_register_issue_tracking',
    description:
      'Register a GitHub issue for comment tracking. New comments on the issue are routed to your current thread. ' +
      'Call after opening or referencing an issue you want to monitor. ' +
      'The server resolves threadId and catId from your invocation identity. ' +
      'GOTCHA: Must be called while callback credentials are still valid.',
    inputSchema: registerIssueTrackingInputSchema,
    handler: handleRegisterIssueTracking,
  },
  {
    name: 'cat_cafe_unregister_tracking',
    description:
      'Unregister a PR or issue tracking task by subjectKey. Stops all automated notifications ' +
      '(review feedback, CI/CD, conflict detection, issue comments) for this subject. ' +
      'Format: "pr:{owner/repo}#{num}" or "issue:{owner/repo}#{num}".',
    inputSchema: unregisterTrackingInputSchema,
    handler: handleUnregisterTracking,
  },
  {
    name: 'cat_cafe_community_await_external',
    description:
      'Declare that you (the case owner) are waiting for an external response on a community case. ' +
      'WHEN: After responding to an issue/PR and explicitly waiting for the reporter or contributor to reply. ' +
      'EFFECT WHILE WAITING: Maintainer (OWNER/MEMBER) activity → silently logged, no wake. ' +
      'External actor (reporter, contributor) activity → auto-restores case to in_progress + wakes you. ' +
      'Provide the subjectKey in "issue:{owner/repo}#{number}" format (e.g. "issue:my-org/my-repo#42").',
    inputSchema: communityAwaitExternalInputSchema,
    handler: handleCommunityAwaitExternal,
  },
  {
    name: 'cat_cafe_update_workflow',
    description:
      'Update the SOP workflow stage for a Feature (Mission Hub bulletin board). ' +
      'Use to record current stage, baton holder, resume capsule, and checks. ' +
      'This is information sharing, not flow control — cats decide their own actions. ' +
      'STAGE VALUES: kickoff → impl → quality_gate → review → merge → completion. ' +
      'TIP: Always set resumeCapsule when updating stage — it helps the next cat cold-start.',
    inputSchema: updateWorkflowInputSchema,
    handler: handleUpdateWorkflow,
  },
  {
    name: 'cat_cafe_multi_mention',
    description:
      'Invoke up to 3 cats in parallel to gather perspectives on a question. ' +
      'All responses are automatically routed back to callbackTo (usually yourself). ' +
      "REQUIRES: searchEvidenceRefs (list what you searched first) OR overrideReason (why you're skipping search). " +
      'This enforces the "先搜后问" principle — always search before asking other cats. ' +
      'Use this instead of multiple @mentions when you need structured multi-cat collaboration with guaranteed response aggregation. ' +
      'GOTCHA: callbackTo is usually your own catId so responses come back to you.',
    inputSchema: multiMentionInputSchema,
    handler: handleMultiMention,
  },
  {
    name: 'cat_cafe_start_vote',
    description:
      'Start a voting session in the current thread for collective decision-making ' +
      '(e.g. "REST vs GraphQL?"). ' +
      'Use when a multi-cat discussion needs a bounded decision, tradeoff vote, or option ranking instead of another round of @ replies. ' +
      'Output: vote prompt message is posted, voters are notified, and the vote result is summarized when all voters respond or timeout expires. ' +
      'Voters receive notification and reply with [VOTE:option]. ' +
      'Auto-closes when all voters have voted or timeout expires (default 120s). ' +
      'GOTCHA: voters must be valid registered catIds (use get_thread_cats to discover them). Options need at least 2 choices.',
    inputSchema: startVoteInputSchema,
    handler: handleStartVote,
  },
  // ============ Bootcamp (F087) ============
  {
    name: 'cat_cafe_update_bootcamp_state',
    description:
      'Update the bootcamp training state for a thread. Use to advance phase, set lead cat, ' +
      'record task selection, store env check results, or mark completion. ' +
      'Fields are merged into existing state — only send what changed. ' +
      'GOTCHA: Only use this during bootcamp threads. Phase values must follow the sequence.',
    inputSchema: updateBootcampStateInputSchema,
    handler: handleUpdateBootcampState,
  },
  {
    name: 'cat_cafe_bootcamp_env_check',
    description:
      'Run environment check for bootcamp (Node.js, pnpm, Git, Claude CLI, MCP, TTS, ASR, Pencil). ' +
      "Results are automatically stored in the thread's bootcampState.envCheck. " +
      'Returns the full check results for display to the user. Only use during bootcamp phase-2-env-check.',
    inputSchema: bootcampEnvCheckInputSchema,
    handler: handleBootcampEnvCheck,
  },
  // F128: Cat-initiated thread proposal (user approves before thread is created)
  {
    name: 'cat_cafe_propose_thread',
    description:
      'Propose a new thread to the user. Returns proposalId, NOT a threadId — the thread is only created after the user approves the proposal card. Use sparingly: ' +
      'only when a clearly separable, long-running discussion genuinely deserves its own thread, or when the owner asks for "新开一个 thread". ' +
      'Do NOT use to escape the current conversation, to split routine tasks, or proactively without an obvious need. ' +
      'parentThreadId defaults to the current thread. After proposing, continue your current work — do not assume the thread exists until the user approves. ' +
      'WRITING @-mentions in `initialMessage`: use the SAME stable handle you use in the current thread (e.g. `@砚砚`, `@opus46`, `@gemini`) — NOT the raw catId form like `@cat-rcs85pvn`. ' +
      'Server normalizes known catIds to stable handles defensively, but always prefer the handle form so the proposal card reads naturally to the user. ' +
      'preferredCats accepts catIds (returned by cat_cafe_get_thread_cats). DISPATCH MODEL: when the user approves, the server wakes ONLY the FIRST cat in preferredCats (the chain starter). Subsequent cats are woken by the chain-driven @-mentions cats write in their own replies. ORDER preferredCats EXACTLY as you want the chain to start (e.g. for 接龙/轮转, put the first 棒 cat first). ' +
      'FORK-AND-RETURN pattern (thread-orchestration skill Step 5c): use `reportingMode` to set the report-back contract. Ask yourself: "做完后源 thread 是否需要结果回来？" — YES (most cases) → omit reportingMode or set `final-only` (default); NO, downstream self-governs → set `none`; need phase updates → `state-transitions`; need blocking ack → `blocking-ack`. Server auto-injects a "## 主 Thread" header with routing credentials (threadId + targetCats/handle) so the last cat knows exactly where and whom to cross-post to. ' +
      'PROJECT OWNERSHIP: if the current/source thread is default/未分类/eval/lobby but the child will do repo or implementation work, pass `projectPath` explicitly. Omit only when the child should inherit the current project, or when it is intentionally meta/eval/unclassified. ' +
      'INTENT — default vs #ideate: by default dispatch wakes only the first preferredCat (serial chain-starter). If you genuinely want PARALLEL independent ideation (everyone replies at once, no chain), tag the message with `#ideate`. With #ideate, dispatch wakes ALL preferredCats simultaneously.',
    inputSchema: proposeThreadInputSchema,
    handler: handleProposeThread,
  },
  // F225: Cat-initiated session handoff (user approves before the current session is sealed + continued)
  {
    name: 'cat_cafe_propose_session_handoff',
    description:
      'Propose handing off your CURRENT session to a fresh continuation of yourself, at a clean breakpoint. ' +
      'Use when you just hit a natural seam — last commit landed, tests green, next step is clear — and context is getting heavy: ' +
      'instead of letting compression silently lossy-summarize you mid-task, you proactively seal HERE and carry a high-fidelity handoff note to the next session. ' +
      'Returns a proposalId, NOT a sealed session — the seal only happens after the owner approves the confirmation card (reject/expire = current session keeps running, nothing is sealed). ' +
      'Write the 五件套 note for the FUTURE you (same thread, same cat, seq+1): done (what you finished) + nextSteps (where to resume) required; worktreeBranch / commits / gotchas optional. ' +
      'The note is injected always-keep into the continuation bootstrap (visible even under the extractive/compress default), so the next you starts with full intent rather than a lossy digest. ' +
      'Use sparingly — only at genuinely clean breakpoints, never to escape a hard task mid-flight. Orthogonal to compression: compress is the lossy fallback, handoff is the graceful relay.',
    inputSchema: proposeSessionHandoffInputSchema,
    handler: handleProposeSessionHandoff,
  },
  // F231 Phase C: Cat-initiated profile-update proposal (operator approves before the primer is written)
  {
    name: 'cat_cafe_propose_profile_update',
    description:
      'Propose an update to YOUR OWN per-cat relationship primer (relationship/{yourCatId}-primer.md) — the "养熟循环" digest entry point (F231 KD-12). ' +
      'Returns a proposalId, NOT a written file: the primer is only written after the operator approves the confirmation card (reject/expire = nothing changes). ' +
      'Use when you have observed a STABLE relationship signal worth persisting — a durable operator preference, communication style, working boundary, or a fact the operator explicitly asked you to remember — not for one-off context. ' +
      'afterContent is the COMPLETE new primer (whole-file replacement, not a diff) — include everything you want kept. ' +
      'The target is ALWAYS your own per-cat primer, derived server-side from your authenticated identity — you cannot target another cat or the shared capsule (capsule promotion is a later phase). ' +
      'Use sparingly: propose when a signal has clearly stabilized, not on every interaction. signalKind records provenance: cat-declared (you inferred it) vs cvo-instructed (the operator told you to).',
    inputSchema: proposeProfileUpdateInputSchema,
    handler: handleProposeProfileUpdate,
  },
  // ============ F155: Guide Engine ============
  {
    name: 'cat_cafe_update_guide_state',
    description:
      'Update the guide session state for a thread after you have already decided a guided flow is appropriate. ' +
      'This is not a raw-text trigger path: do not infer guide offers from `/guide` or keywords alone. ' +
      'First call creates state (status must be "offered"). Subsequent calls must follow valid non-start transitions: ' +
      'offered→awaiting_choice/cancelled, awaiting_choice→cancelled, active→completed/cancelled. ' +
      'Do not use this tool to enter "active" — call cat_cafe_start_guide for offered/awaiting_choice→active so frontend start side effects run. ' +
      'One active guide per thread — complete or cancel before offering a new one.',
    inputSchema: updateGuideStateInputSchema,
    handler: handleUpdateGuideState,
  },
  {
    name: 'cat_cafe_get_available_guides',
    description:
      'Fetch the current catalog of guides that are actually available in this thread context. ' +
      'Use this after you decide a user likely needs a step-by-step walkthrough instead of a plain explanation. ' +
      'Returns guide IDs, names, descriptions, categories, priorities, and estimated times so you can recommend the best-fit guide to the user. ' +
      'Do not guess from keywords alone — inspect the returned guide metadata first, then ask the user whether to start one. ' +
      'On confirmation, call cat_cafe_start_guide with the chosen guideId.',
    inputSchema: getAvailableGuidesInputSchema,
    handler: handleGetAvailableGuides,
  },
  // F193 Phase D AC-D2: cat_cafe_guide_resolve legacy alias removed.
  // Replaced by cat_cafe_get_available_guides — let the cat inspect catalog
  // metadata directly rather than guess from a single intent string.
  {
    name: 'cat_cafe_start_guide',
    description:
      'Start an interactive guided flow on the Console frontend. ' +
      'Requires the guide to be in "offered" or "awaiting_choice" state (call cat_cafe_update_guide_state first after you intentionally offered the guide). ' +
      'Transitions guide to "active" and emits socket event for frontend overlay.',
    inputSchema: {
      guideId: z.string().min(1).describe('Guide flow ID (e.g. "add-member")'),
    },
    handler: handleStartGuide,
  },
  {
    name: 'cat_cafe_guide_control',
    description:
      'Control an active guide session. Requires guide to be in "active" state. ' +
      'Actions: "next" (advance), "skip" (skip step), "exit" (cancel guide). ' +
      'Use this only after a guide has been explicitly started; forward-only — no back.',
    inputSchema: {
      action: z.enum(['next', 'skip', 'exit']).describe('Guide control action'),
    },
    handler: handleGuideControl,
  },
  {
    name: 'cat_cafe_hold_ball',
    description:
      'Declare a bounded ball hold: keep the ball while waiting for a short, predictable condition, then get auto-re-invoked with your context. ' +
      'Use when: ball is clearly yours + nobody else can advance + short predictable wait ' +
      '(e.g. CI running, build compiling, PR checks pending) + you know exactly what to do next. ' +
      'NOT for: need review/approval → @ reviewer or @co-creator; need another cat to act → @ that cat; ' +
      '"let me think" / "I\'ll hold for now" → hesitation not hold, pick 接/退/升; ' +
      'review/analysis done → MUST @ author, conclusion ≠ endpoint; status updates → use post_message. ' +
      'Output: system schedules a one-shot wake-up after wakeAfterMs; you get re-invoked with reason + nextStep as trigger context. ' +
      'GOTCHA: max 3 holds per (thread, cat) within a rolling ~1h window — 4th call returns 429, you MUST pass (@ another cat or @co-creator). ' +
      'GOTCHA: the counter is process-local best-effort (in-memory on the API node); API restart or multi-instance deploys may reset it, so do not treat the 429 as a hard security boundary — treat it as a self-discipline guardrail. ' +
      'GOTCHA: hold is an EXCEPTION state, not a default exit. Most turns should end with @ someone, not hold. ' +
      'GOTCHA (F167 Phase M): only hold for harness-INVISIBLE waits — external conditions nothing will call you back about (cloud review verdict, remote CI, external webhook). Background work the harness already tracks (a background Bash command, a spawned task) AUTO-RE-INVOKES you on completion; holding for that just stacks a redundant wake on top. Ask "will something call me back already?" — if yes, do NOT hold. ' +
      'GOTCHA: SINGLE-SLOT per (thread, cat) — calling hold_ball again while a previous hold is pending REPLACES the prior wake (prior taskId cancelled). This is intentional (KD-23): hold = "持一个球" exception, not a queue. If you need to track multiple waiting conditions, merge them into one nextStep (e.g. "等 CI + @co-creator 确认" 合并成一句). Rolling-window counter still ticks per call.',
    inputSchema: {
      reason: z.string().min(1).max(500).describe('Why you need to hold the ball (e.g. "tests still running")'),
      nextStep: z
        .string()
        .min(1)
        .max(500)
        .describe('What you will do when re-invoked (e.g. "check test results, then @ author")'),
      wakeAfterMs: z.number().int().min(5000).max(3600000).describe('Delay in ms before system re-invokes you (5s–1h)'),
    },
    handler: handleHoldBall,
  },
] as const;
