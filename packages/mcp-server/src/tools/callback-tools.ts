/**
 * MCP Callback Tools — core callbacks
 * 鉴权: process.env CAT_CAFE_INVOCATION_ID + CAT_CAFE_CALLBACK_TOKEN
 */

import { randomUUID } from 'node:crypto';
import { normalizeRichBlock } from '@cat-cafe/shared';
import { z } from 'zod';
import { sendCallbackRequest } from './callback-outbox.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

interface CallbackConfig {
  apiUrl: string;
  invocationId: string;
  callbackToken: string;
}

export function getCallbackConfig(): CallbackConfig | null {
  const apiUrl = process.env['CAT_CAFE_API_URL'];
  const invocationId = process.env['CAT_CAFE_INVOCATION_ID'];
  const callbackToken = process.env['CAT_CAFE_CALLBACK_TOKEN'];
  if (!apiUrl || !invocationId || !callbackToken) return null;
  return { apiUrl, invocationId, callbackToken };
}

export const NO_CONFIG_ERROR =
  'Clowder AI callback not configured. Missing CAT_CAFE_API_URL, CAT_CAFE_INVOCATION_ID, or CAT_CAFE_CALLBACK_TOKEN environment variables.';
// ============ HTTP helpers ============

export function buildAuthHeaders(config: CallbackConfig): Record<string, string> {
  return {
    'x-invocation-id': config.invocationId,
    'x-callback-token': config.callbackToken,
  };
}

function withLegacyAuthBody(config: CallbackConfig, body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
  };
}

function withLegacyAuthQuery(config: CallbackConfig, params?: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    ...(params ?? {}),
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
  });
}

export async function callbackPost(
  path: string,
  body: Record<string, unknown>,
  options?: { enableOutbox?: boolean },
): Promise<ToolResult> {
  const config = getCallbackConfig();
  if (!config) return errorResult(NO_CONFIG_ERROR);

  const result = await sendCallbackRequest(
    {
      apiUrl: config.apiUrl,
      path,
      // Compat window: send credentials in both headers and legacy body fields
      // so a newer MCP client can still talk to an older API during rollout.
      body: withLegacyAuthBody(config, body),
      headers: buildAuthHeaders(config),
    },
    { enableOutbox: options?.enableOutbox === true },
  );
  if (result.ok) return successResult(JSON.stringify(result.data));
  return errorResult(result.error);
}

export async function callbackGet(path: string, params?: Record<string, string>): Promise<ToolResult> {
  const config = getCallbackConfig();
  if (!config) return errorResult(NO_CONFIG_ERROR);

  const query = withLegacyAuthQuery(config, params);
  const qs = query.toString();
  const url = qs ? `${config.apiUrl}${path}?${qs}` : `${config.apiUrl}${path}`;

  try {
    const response = await fetch(url, { headers: buildAuthHeaders(config) });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Callback failed (${response.status}): ${text}`);
    }
    return successResult(JSON.stringify(await response.json()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Callback request failed: ${message}`);
  }
}

export const postMessageInputSchema = {
  content: z.string().min(1).describe('The message content to post'),
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
      'Optional explicit target cat IDs. Merged with @mentions parsed from content. Used for direction rendering in frontend. Use get_thread_cats to discover valid catIds.',
    ),
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
    .default(20)
    .describe('Number of recent messages to retrieve (default: 20)'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional: read messages from a different thread. Omit to read the current thread.'),
  catId: z.string().min(1).optional().describe("Optional: filter by speaker catId, or pass 'user' for human messages."),
  keyword: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: filter and rank messages by keyword relevance. Multi-word keywords are tokenized and scored (0-1). Results sorted by relevance when keyword is provided.',
    ),
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
  ownerCatId: z.string().min(1).optional().describe('Cat ID to assign the task to (optional, defaults to unassigned)'),
};

export const updateTaskInputSchema = {
  taskId: z.string().min(1).describe('The ID of the task to update'),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional().describe('New task status'),
  why: z.string().max(1000).optional().describe('Optional note explaining the status change'),
};

export const crossPostMessageInputSchema = {
  threadId: z.string().min(1).describe('Target thread ID to post into'),
  content: z.string().min(1).describe('The message content to post'),
  replyTo: z.string().optional().describe('Optional message ID to reply to'),
  clientMessageId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key for at-least-once delivery de-duplication'),
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

export async function handlePostMessage(input: {
  content: string;
  threadId?: string | undefined;
  replyTo?: string | undefined;
  clientMessageId?: string | undefined;
  targetCats?: string[] | undefined;
}): Promise<ToolResult> {
  const result = await callbackPost(
    '/api/callbacks/post-message',
    {
      content: input.content,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      clientMessageId: input.clientMessageId ?? randomUUID(),
      ...(input.targetCats?.length ? { targetCats: input.targetCats } : {}),
    },
    { enableOutbox: true },
  );

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
  // Only mention credential issues when the error actually looks like auth failure.
  if (result.isError && /[@＠]/.test(input.content)) {
    const original = (result.content[0] as { text: string }).text;
    const lower = original.toLowerCase();
    const looksLikeCredentialFailure =
      lower.includes('callback failed (401)') ||
      lower.includes('invalid or expired callback credentials') ||
      lower.includes('callback token');
    const reasonHint = looksLikeCredentialFailure
      ? '这次 callback 凭证校验失败（可能是 token 过期，也可能 invocation/token 不匹配）。'
      : '这次 post-message 调用失败。';
    const hint =
      `\n\n💡 Tip: ${reasonHint}如果你想 @其他猫猫，` +
      '不需要用这个 MCP tool——直接在你的回复文本里另起一行写 @猫名 即可' +
      '（例如另起一行写 @缅因猫），系统会自动检测并触发。';
    return errorResult(original + hint);
  }

  return result;
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
  catId?: string | undefined;
  keyword?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet('/api/callbacks/thread-context', {
    ...(input.limit ? { limit: String(input.limit) } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.catId ? { catId: input.catId } : {}),
    ...(input.keyword ? { keyword: input.keyword } : {}),
  });
}

export async function handleListThreads(input: {
  limit?: number | undefined;
  activeSince?: number | undefined;
  keyword?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet('/api/callbacks/list-threads', {
    ...(input.limit ? { limit: String(input.limit) } : {}),
    ...(input.activeSince !== undefined ? { activeSince: String(input.activeSince) } : {}),
    ...(input.keyword ? { keyword: input.keyword } : {}),
  });
}

export async function handleFeatIndex(input: {
  limit?: number | undefined;
  featId?: string | undefined;
  query?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet('/api/callbacks/feat-index', {
    ...(input.limit ? { limit: String(input.limit) } : {}),
    ...(input.featId ? { featId: input.featId } : {}),
    ...(input.query ? { query: input.query } : {}),
  });
}

export async function handleUpdateTask(input: {
  taskId: string;
  status?: string | undefined;
  why?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/update-task', {
    taskId: input.taskId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.why ? { why: input.why } : {}),
  });
}

export async function handleCreateTask(input: {
  title: string;
  why?: string | undefined;
  ownerCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/create-task', {
    title: input.title,
    ...(input.why ? { why: input.why } : {}),
    ...(input.ownerCatId ? { ownerCatId: input.ownerCatId } : {}),
  });
}

export async function handleCrossPostMessage(input: {
  threadId: string;
  content: string;
  replyTo?: string | undefined;
  clientMessageId?: string | undefined;
}): Promise<ToolResult> {
  return handlePostMessage({
    threadId: input.threadId,
    content: input.content,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
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
};

/**
 * #84: Route A → Route B fallback for rich block creation.
 * Tries direct callback first; on failure, falls back to post_message with cc_rich text
 * (which is extracted server-side after #83 fix).
 */
export async function handleCreateRichBlock(input: { block: string }): Promise<ToolResult> {
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

  // Route A: direct rich block callback (buffers for invocation response)
  const result = await callbackPost(
    '/api/callbacks/create-rich-block',
    {
      block: parsed,
    },
    { enableOutbox: true },
  );
  if (!result.isError) return result;

  // P1 cloud-review: only fallback to Route B for auth/config failures.
  // Validation errors (400/422) must surface directly, not be silently swallowed.
  const errorText = result.content[0]?.type === 'text' ? result.content[0].text : '';
  const isAuthOrConfigFailure = /\(40[13]\)/.test(errorText) || /not configured/i.test(errorText);
  if (!isAuthOrConfigFailure) return result;

  // Route A auth/config failed — try Route B: cc_rich text via post_message (#83 extracts it server-side)
  const ccRichText = `\`\`\`cc_rich\n${JSON.stringify({ v: 1, blocks: [parsed] })}\n\`\`\``;
  const fallback = await handlePostMessage({
    content: ccRichText,
    clientMessageId: randomUUID(),
  });
  if (!fallback.isError) {
    return successResult(JSON.stringify({ status: 'ok', route: 'B_fallback' }));
  }

  // Both routes failed — return error with embeddable cc_rich hint
  return errorResult(
    `Rich block creation failed (callback token expired or missing). As a workaround, include this in your message text:\n\n${ccRichText}`,
  );
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
  catId: z
    .string()
    .optional()
    .describe('Deprecated — server auto-resolves from invocation identity. Ignored if provided.'),
};

export async function handleRegisterPrTracking(input: {
  repoFullName: string;
  prNumber: number;
  catId?: string;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/register-pr-tracking', {
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    ...(input.catId ? { catId: input.catId } : {}),
  });
}

export const updateWorkflowInputSchema = {
  backlogItemId: z.string().min(1).describe('The backlog item ID to update workflow SOP for'),
  featureId: z.string().min(1).describe('Feature ID (e.g. "F073")'),
  stage: z
    .enum(['kickoff', 'impl', 'quality_gate', 'review', 'merge', 'completion'])
    .optional()
    .describe('Current SOP stage'),
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
  if (input.stage !== undefined) body['stage'] = input.stage;
  if (input.batonHolder !== undefined) body['batonHolder'] = input.batonHolder;
  if (input.nextSkill !== undefined) body['nextSkill'] = input.nextSkill;
  if (input.resumeCapsule !== undefined) body['resumeCapsule'] = input.resumeCapsule;
  if (input.checks !== undefined) body['checks'] = input.checks;
  if (input.expectedVersion !== undefined) body['expectedVersion'] = input.expectedVersion;
  return callbackPost('/api/callbacks/update-workflow-sop', body);
}

// ============ Multi-Mention (F086) ============

export const multiMentionInputSchema = {
  targets: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .describe('Cat IDs to invoke in parallel (max 3). Use get_thread_cats to discover valid catIds.'),
  question: z.string().min(1).max(5000).describe('The question or request for the target cats'),
  callbackTo: z.string().min(1).describe('Cat ID to route all responses back to (required, usually yourself)'),
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
    .describe('CatIds of voters. Use get_thread_cats to discover valid catIds.'),
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
      'phase-0-select-cat',
      'phase-1-intro',
      'phase-2-env-check',
      'phase-3-config-help',
      'phase-3.5-advanced',
      'phase-4-task-select',
      'phase-5-kickoff',
      'phase-6-design',
      'phase-7-dev',
      'phase-8-review',
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
  completedAt: z.number().optional().describe('Timestamp when bootcamp was completed (Phase 11)'),
};

export async function handleUpdateBootcampState(input: {
  threadId: string;
  phase?: string | undefined;
  leadCat?: string | undefined;
  selectedTaskId?: string | undefined;
  envCheck?: Record<string, { ok: boolean; version?: string; note?: string }> | undefined;
  advancedFeatures?: Record<string, string> | undefined;
  completedAt?: number | undefined;
}): Promise<ToolResult> {
  const body: Record<string, unknown> = { threadId: input.threadId };
  if (input.phase !== undefined) body['phase'] = input.phase;
  if (input.leadCat !== undefined) body['leadCat'] = input.leadCat;
  if (input.selectedTaskId !== undefined) body['selectedTaskId'] = input.selectedTaskId;
  if (input.envCheck !== undefined) body['envCheck'] = input.envCheck;
  if (input.advancedFeatures !== undefined) body['advancedFeatures'] = input.advancedFeatures;
  if (input.completedAt !== undefined) body['completedAt'] = input.completedAt;
  return callbackPost('/api/callbacks/update-bootcamp-state', body);
}

export const bootcampEnvCheckInputSchema = {
  threadId: z.string().min(1).describe('Thread ID — results are auto-stored in bootcampState.envCheck'),
};

export async function handleBootcampEnvCheck(input: { threadId: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/bootcamp-env-check', { threadId: input.threadId });
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
  if (input.currentStep !== undefined) body['currentStep'] = input.currentStep;
  return callbackPost('/api/callbacks/update-guide-state', body);
}

export async function handleStartGuide(input: { guideId: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/start-guide', { guideId: input.guideId });
}

export const getAvailableGuidesInputSchema = {};

export async function handleGetAvailableGuides(): Promise<ToolResult> {
  return callbackPost('/api/callbacks/get-available-guides', {});
}

export async function handleGuideControl(input: { action: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/guide-control', { action: input.action });
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
      'GOTCHA: Requires threadId — use list_threads or feat_index to find the right thread first.',
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
      'Update the status of a task you own. Use to mark tasks as doing/blocked/done. ' +
      'GOTCHA: You can only update tasks assigned to you (your catId). ' +
      'TIP: Include a "why" note when marking as blocked — it helps others understand the situation.',
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
      'Output: task appears in the thread 🧶 毛线球 panel, persists across sessions, visible to all cats and 铲屎官. ' +
      'GOTCHA: 毛线球 ≠ checklist rich block. 毛线球 lives in the task panel and survives session boundaries; checklist is ephemeral inline content in one message. ' +
      'TIP: Include a "why" to give context to whoever picks up the task.',
    inputSchema: createTaskInputSchema,
    handler: handleCreateTask,
  },
  {
    name: 'cat_cafe_create_rich_block',
    description:
      'Create a rich block (card, diff, checklist, media_gallery, audio, or interactive) attached to the current message. ' +
      'Use card for status/decisions, diff for code changes, checklist for inline todos, media_gallery for images, audio for voice, interactive for user selection/confirmation. ' +
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
      'Register a PR for email review notification routing. Call right after `gh pr create` ' +
      'so that cloud Codex review emails are automatically routed to your current thread. ' +
      'The server resolves threadId and catId from your invocation identity — you only need repoFullName and prNumber. ' +
      'GOTCHA: Must be called in the same session that created the PR, while callback credentials are still valid.',
    inputSchema: registerPrTrackingInputSchema,
    handler: handleRegisterPrTracking,
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
      '(e.g. "REST vs GraphQL?"). Voters receive notification and reply with [VOTE:option]. ' +
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
] as const;
