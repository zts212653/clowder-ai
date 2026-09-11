import { type CatId, normalizeThreadGoalObjective } from '@cat-cafe/shared';
import { isCodexSessionReplacementProvenance } from '../../runtime-session/CodexSessionReplacementProvenance.js';
import type { AgentMessage } from '../../types.js';

export interface CodexReconnectNotice {
  message: string;
  attempt?: number;
}

export function parseCodexReconnectNotice(event: unknown): CodexReconnectNotice | null {
  if (typeof event !== 'object' || event === null) return null;
  const raw = event as Record<string, unknown>;
  if (raw.type !== 'error' || typeof raw.message !== 'string') return null;
  const message = raw.message.trim();
  if (!message.startsWith('Reconnecting...')) return null;
  const attemptMatch = message.match(/(?:Reconnecting\.\.\.\s*|attempt\s+)(\d+)/i);
  return {
    message,
    ...(attemptMatch ? { attempt: Number(attemptMatch[1]) } : {}),
  };
}

import { normalizeTaskStatus } from '../invocation/invoke-helpers.js';
import { type CodexApprovalSurface, classifyCodexGithubAppApprovalFailure } from './codex-app-approval-routing.js';

// F060: Allowed image MIME types and max base64 payload size (5 MB encoded ≈ 3.75 MB decoded)
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const MAX_BASE64_LENGTH = 5 * 1024 * 1024;

/**
 * Mutable state for tracking Codex multi-turn text separation.
 * Each `item.completed` with `agent_message` is a complete turn;
 * without explicit separation, consecutive turns get concatenated
 * without paragraph breaks (unlike Claude's incremental deltas which
 * naturally include the model's own whitespace).
 */
export interface CodexStreamState {
  hadPriorTextTurn: boolean;
  /** Cat nickname/display name used to distinguish this cat's signature from quoted teammate signatures. */
  signatureIdentity?: string;
  /** Runtime-derived signature appended once after the provider stream ends normally. */
  canonicalSignature?: string;
  /** Latest provider-authored own signature, used only when runtime config cannot provide one. */
  observedSignature?: string;
  /** Chronological terminal truth; only a final successful stream may receive a signature. */
  lastTurnTerminal?: 'successful' | 'non_success';
  finalSignatureEmitted?: boolean;
}

interface StrippedTurnSignature {
  content: string;
  signature?: string;
}

const MARKDOWN_CONTAINER_ONLY_PREFIX_RE =
  /^[ \t]{0,3}(?:(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)|(?:>[ \t]*))+(?:\[[ xX]\][ \t]+)?$/u;
const MARKDOWN_LEADING_CONTAINER_RE = /^[ \t]{0,3}(?:(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)|(?:>[ \t]*))+/u;
const FENCE_RUN_RE = /(`{3,}|~{3,})/u;

const PAW_SIGNATURE_RE = /^\[([^[\]/\n]+)\/([^[\]\n]+)🐾\]$/u;
const TRAILING_PAW_SIGNATURE_RE = /`?(\[([^[\]/\n]+)\/([^[\]\n]+)🐾(?:@([^[\]\n]+))?\])`?[ \t]*$/u;

function isOwnSignatureIdentity(candidate: string, expected: string): boolean {
  const normalizedCandidate = candidate.trim();
  const normalizedExpected = expected.trim();
  return normalizedCandidate === normalizedExpected || normalizedCandidate.endsWith(`·${normalizedExpected}`);
}

function normalizeSignatureModel(model: string): string {
  return model
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');
}

function isCanonicalOwnSignature(
  candidateIdentity: string,
  candidateModel: string,
  candidateCatId: string | undefined,
  expectedIdentity: string,
  canonicalSignature: string | undefined,
  expectedCatId: CatId,
): boolean {
  if (!isOwnSignatureIdentity(candidateIdentity, expectedIdentity)) return false;
  if (!canonicalSignature) return false;

  const canonical = PAW_SIGNATURE_RE.exec(canonicalSignature.trim());
  const canonicalIdentity = canonical?.[1];
  const canonicalModel = canonical?.[2];
  if (!canonicalIdentity || !canonicalModel || !isOwnSignatureIdentity(canonicalIdentity, expectedIdentity)) {
    return false;
  }
  const normalizedCandidateModel = normalizeSignatureModel(candidateModel);
  const normalizedCanonicalModel = normalizeSignatureModel(canonicalModel);
  if (normalizedCandidateModel === normalizedCanonicalModel) {
    return candidateCatId === undefined || candidateCatId.trim() === expectedCatId;
  }
  return candidateCatId?.trim() === expectedCatId && normalizedCandidateModel.endsWith(normalizedCanonicalModel);
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
  continuationIndent: number;
}

interface MarkdownFenceLine extends MarkdownFence {
  suffix: string;
}

function isAllowedFencePrefix(prefix: string, openFence: MarkdownFence | undefined, isContainer: boolean): boolean {
  if (!openFence) return (/^ *$/u.test(prefix) && prefix.length <= 3) || isContainer;
  if (prefix.includes('>') && isContainer) return true;
  if (!/^ *$/u.test(prefix)) return false;
  if (openFence.continuationIndent === 0) return prefix.length <= 3;
  return prefix.length >= openFence.continuationIndent && prefix.length <= openFence.continuationIndent + 3;
}

function parseMarkdownFenceLine(line: string, openFence?: MarkdownFence): MarkdownFenceLine | undefined {
  const match = FENCE_RUN_RE.exec(line);
  if (!match || match.index === undefined) return undefined;

  const prefix = line.slice(0, match.index);
  const isContainerPrefix = MARKDOWN_CONTAINER_ONLY_PREFIX_RE.test(prefix);
  if (!isAllowedFencePrefix(prefix, openFence, isContainerPrefix)) return undefined;

  const run = match[0];
  const marker = run[0];
  if (marker !== '`' && marker !== '~') return undefined;
  return {
    marker,
    length: run.length,
    continuationIndent: isContainerPrefix ? prefix.length : 0,
    suffix: line.slice(match.index + run.length),
  };
}

function isInsideFencedCode(text: string, candidateIndex: number): boolean {
  let openFence: MarkdownFence | undefined;
  const prefixLines = text.slice(0, candidateIndex).split(/\r?\n/);
  for (const line of prefixLines) {
    if (!openFence) {
      const opening = parseMarkdownFenceLine(line);
      if (!opening || (opening.marker === '`' && opening.suffix.includes('`'))) continue;
      openFence = opening;
      continue;
    }

    const closing = parseMarkdownFenceLine(line, openFence);
    if (
      closing?.marker === openFence.marker &&
      closing.length >= openFence.length &&
      /^[ \t]*$/u.test(closing.suffix)
    ) {
      openFence = undefined;
    }
  }
  return openFence !== undefined;
}

function isMarkdownSignatureSampleContext(text: string, candidateIndex: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(0, candidateIndex - 1)) + 1;
  const linePrefix = text.slice(lineStart, candidateIndex);
  if (MARKDOWN_CONTAINER_ONLY_PREFIX_RE.test(linePrefix)) return true;
  const leadingContainers = MARKDOWN_LEADING_CONTAINER_RE.exec(linePrefix);
  if (leadingContainers?.[0].includes('>')) return true;
  if (/^(?: {4,}| {0,3}\t)/u.test(linePrefix)) return true;
  return false;
}

/**
 * Remove only this cat's runtime-canonical signature when it is the terminal token
 * of one complete Codex `agent_message` turn. Same-cat signatures for other models,
 * quoted/fenced examples, and teammate signatures are content, not transport
 * decoration, and must survive finalization.
 */
function stripOwnTrailingTurnSignature(
  text: string,
  signatureIdentity: string | undefined,
  canonicalSignature: string | undefined,
  catId: CatId,
): StrippedTurnSignature {
  if (!signatureIdentity) return { content: text };
  const match = TRAILING_PAW_SIGNATURE_RE.exec(text);
  if (!match || match.index === undefined) return { content: text };
  const candidateIdentity = match[2];
  const candidateModel = match[3];
  const candidateCatId = match[4];
  if (
    !candidateIdentity ||
    !candidateModel ||
    !isCanonicalOwnSignature(
      candidateIdentity,
      candidateModel,
      candidateCatId,
      signatureIdentity,
      canonicalSignature,
      catId,
    )
  ) {
    return { content: text };
  }

  if (isMarkdownSignatureSampleContext(text, match.index) || isInsideFencedCode(text, match.index)) {
    return { content: text };
  }

  return {
    content: text.slice(0, match.index).trimEnd(),
    signature: match[1],
  };
}

export interface CodexEventTransformOptions {
  approvalSurface?: CodexApprovalSurface;
}

/**
 * Append the canonical signature only after the provider event stream has
 * ended normally. A `turn.completed` event is not itself a stream boundary:
 * Codex may emit another turn before the NDJSON iterator is exhausted.
 */
export function finalizeCodexStream(state: CodexStreamState, catId: CatId): AgentMessage | null {
  if (
    state.lastTurnTerminal !== 'successful' ||
    (!state.hadPriorTextTurn && !state.observedSignature) ||
    state.finalSignatureEmitted
  ) {
    return null;
  }
  const signature = state.canonicalSignature ?? state.observedSignature;
  if (!signature) return null;
  state.finalSignatureEmitted = true;
  return {
    type: 'text',
    catId,
    content: `\n\n${signature}`,
    timestamp: Date.now(),
  };
}

/**
 * Transform a raw Codex CLI NDJSON event into an AgentMessage.
 * Returns null to skip events we don't care about.
 *
 * When `state` is provided, consecutive agent_message text turns are
 * separated by `\n\n` to preserve paragraph breaks between turns.
 */
export function transformCodexEvent(
  event: unknown,
  catId: CatId,
  state?: CodexStreamState,
  options?: CodexEventTransformOptions,
): AgentMessage | AgentMessage[] | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;

  if (state) {
    if (e.type === 'turn.completed') {
      state.lastTurnTerminal = e.status === undefined || e.status === 'completed' ? 'successful' : 'non_success';
    } else if (e.type === 'turn.failed') {
      state.lastTurnTerminal = 'non_success';
    } else if (
      e.type === 'turn.started' ||
      e.type === 'item.started' ||
      e.type === 'item.updated' ||
      e.type === 'item.completed'
    ) {
      delete state.lastTurnTerminal;
    }
  }

  if (e.type === 'thread.started') {
    const threadId = e.thread_id;
    if (typeof threadId !== 'string') return null;
    const sessionReplacement = isCodexSessionReplacementProvenance(e.session_replacement)
      ? e.session_replacement
      : undefined;
    return {
      type: 'session_init',
      catId,
      sessionId: threadId,
      ...(sessionReplacement ? { sessionReplacement } : {}),
      timestamp: Date.now(),
    };
  }

  if (e.type === 'thread.goal.updated') {
    const goal = typeof e.goal === 'object' && e.goal !== null ? (e.goal as Record<string, unknown>) : null;
    const objective = normalizeThreadGoalObjective(goal?.objective);
    if (
      typeof e.thread_id !== 'string' ||
      !goal ||
      !objective ||
      !isCodexGoalStatus(goal.status) ||
      typeof goal.updatedAt !== 'number' ||
      !Number.isFinite(goal.updatedAt)
    ) {
      return null;
    }
    return {
      type: 'provider_signal',
      catId,
      nativeGoalObservation: {
        state: 'updated',
        runtimeSessionId: e.thread_id,
        objective,
        status: goal.status,
        tokenBudget:
          typeof goal.tokenBudget === 'number' && Number.isFinite(goal.tokenBudget) ? goal.tokenBudget : null,
        providerUpdatedAt: goal.updatedAt,
        source: 'codex_app_server',
      },
      timestamp: Date.now(),
    };
  }

  if (e.type === 'thread.goal.cleared') {
    if (typeof e.thread_id !== 'string') return null;
    return {
      type: 'provider_signal',
      catId,
      nativeGoalObservation: {
        state: 'cleared',
        runtimeSessionId: e.thread_id,
        source: 'codex_app_server',
      },
      timestamp: Date.now(),
    };
  }

  if (e.type === 'turn.plan.updated') {
    const occurredAt = Date.now();
    const rawPlan = Array.isArray(e.plan) ? e.plan : [];
    const planItems = rawPlan
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry !== 'object' || entry === null) return '';
        const record = entry as Record<string, unknown>;
        return typeof record.step === 'string'
          ? record.step
          : typeof record.text === 'string'
            ? record.text
            : typeof record.description === 'string'
              ? record.description
              : '';
      })
      .filter(Boolean);
    const explanation = typeof e.explanation === 'string' ? e.explanation.trim() : '';
    const text = explanation || planItems.join(' · ') || '计划已更新';
    return {
      type: 'provider_signal',
      catId,
      semanticEvent: {
        v: 1,
        id: `plan:codex:${catId}:${occurredAt}`,
        kind: 'plan',
        occurredAt,
        stage: 'updated',
        text,
        totalItems: rawPlan.length,
        provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'turn/plan/updated' },
      },
      timestamp: occurredAt,
    };
  }

  // F045: todo_list (started/updated/completed) → system_info(task_progress)
  // Checked BEFORE item.started/item.completed type guards below
  const isTodoList =
    (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') &&
    (e.item as Record<string, unknown> | undefined)?.type === 'todo_list';
  if (isTodoList) {
    const todoItem = e.item as Record<string, unknown>;
    const rawItems = Array.isArray(todoItem.todo_items)
      ? (todoItem.todo_items as Array<Record<string, unknown>>)
      : Array.isArray(todoItem.items)
        ? (todoItem.items as Array<Record<string, unknown>>)
        : [];
    const tasks = rawItems.map((t, i) => {
      const subject = typeof t.content === 'string' ? t.content : typeof t.text === 'string' ? t.text : '';
      const rawStatus =
        typeof t.status === 'string'
          ? t.status
          : typeof t.completed === 'boolean'
            ? t.completed
              ? 'completed'
              : 'pending'
            : 'pending';
      return {
        id: typeof t.id === 'string' ? t.id : `task-${i}`,
        subject: subject.slice(0, 120),
        status: normalizeTaskStatus(rawStatus),
      };
    });
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'task_progress', catId, action: 'snapshot', tasks }),
      timestamp: Date.now(),
    };
  }

  if (e.type === 'item.started') {
    const item = e.item as Record<string, unknown> | undefined;

    // F045: mcp_tool_call started → tool_use
    if (item?.type === 'mcp_tool_call') {
      const server = typeof item.server === 'string' ? item.server : 'unknown';
      const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
      const args =
        typeof item.arguments === 'object' && item.arguments !== null
          ? (item.arguments as Record<string, unknown>)
          : {};
      // F153 Phase J AC-J2: Codex uses item.id as the lifecycle anchor (no tool_call_id field).
      const msg: AgentMessage = {
        type: 'tool_use',
        catId,
        toolName: `mcp:${server}/${tool}`,
        toolSource: 'mcp',
        toolChannel: 'unknown',
        toolInput: args,
        timestamp: Date.now(),
      };
      if (typeof item.id === 'string') msg.toolUseId = item.id;
      return msg;
    }

    if (item?.type !== 'command_execution') return null;
    const command = item.command;
    if (typeof command !== 'string') return null;
    return {
      type: 'tool_use',
      catId,
      toolName: 'command_execution',
      toolSource: 'host_cli',
      toolChannel: 'unknown',
      toolInput: { command },
      ...(typeof item.id === 'string' ? { toolUseId: item.id } : {}),
      timestamp: Date.now(),
    };
  }

  if (e.type === 'error') {
    const reconnect = parseCodexReconnectNotice(e);
    // Reconnecting is a transient provider lifecycle transition, not a
    // permanent warning. The service later emits recovered/failed for the
    // same invocation-scoped projection.
    if (reconnect) {
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'reconnecting',
          ...(reconnect.attempt !== undefined ? { attempt: reconnect.attempt } : {}),
          message: reconnect.message,
        }),
        timestamp: Date.now(),
      };
    }
    // Non-Reconnecting errors: return null — CodexAgentService collects them via
    // collectCodexStreamError() and surfaces them as diagnostics in the exit error.
    return null;
  }

  if (e.type === 'turn.completed') {
    return null;
  }

  if (e.type !== 'item.completed') return null;

  const item = e.item as Record<string, unknown> | undefined;

  if (item?.type === 'reasoning') {
    const occurredAt = Date.now();
    const rawSummary = Array.isArray(item.summary)
      ? item.summary
          .map((part) =>
            typeof part === 'string'
              ? part
              : typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string'
                ? ((part as Record<string, unknown>).text as string)
                : '',
          )
          .filter(Boolean)
          .join('\n')
      : typeof item.text === 'string'
        ? item.text
        : typeof item.content === 'string'
          ? item.content
          : '';
    if (!rawSummary.trim()) return null;
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'thinking', catId, text: rawSummary.trim() }),
      timestamp: occurredAt,
    };
  }

  if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim().length > 0) {
    const stripped = stripOwnTrailingTurnSignature(
      item.text,
      state?.signatureIdentity,
      state?.canonicalSignature,
      catId,
    );
    if (state && stripped.signature) state.observedSignature = stripped.signature;
    if (stripped.content.trim().length === 0) return null;
    const prefix = state?.hadPriorTextTurn ? '\n\n' : '';
    if (state) state.hadPriorTextTurn = true;
    return {
      type: 'text',
      catId,
      content: prefix + stripped.content,
      timestamp: Date.now(),
    };
  }

  if (item?.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    const status = typeof item.status === 'string' ? item.status : 'completed';
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
    const toolResultStatus: 'ok' | 'error' | 'unknown' =
      exitCode !== null
        ? exitCode === 0
          ? 'ok'
          : 'error'
        : status === 'failed' || status === 'error'
          ? 'error'
          : status === 'completed'
            ? 'ok'
            : 'unknown';

    const sections: string[] = [];
    if (command) sections.push(`command: ${command}`);
    sections.push(`status: ${status}`);
    if (exitCode !== null) sections.push(`exit_code: ${exitCode}`);
    const trimmedOutput = output.trimEnd();
    if (trimmedOutput) sections.push(trimmedOutput);

    return {
      type: 'tool_result',
      catId,
      toolName: 'command_execution',
      toolSource: 'host_cli',
      toolChannel: 'unknown',
      toolResultStatus,
      content: sections.join('\n'),
      ...(typeof item.id === 'string' ? { toolUseId: item.id } : {}),
      timestamp: Date.now(),
    };
  }

  if (item?.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const status = typeof item.status === 'string' ? item.status : 'completed';
    const occurredAt = Date.now();
    return {
      type: 'tool_use',
      catId,
      toolName: 'file_change',
      toolSource: 'host_cli',
      toolChannel: 'unknown',
      toolInput: { status, changes },
      semanticEvent: {
        v: 1,
        id: `diff:codex:${typeof item.id === 'string' ? item.id : occurredAt}`,
        kind: 'diff',
        occurredAt,
        stage: status === 'completed' ? 'completed' : 'updated',
        summary: `${changes.length} 个文件变更`,
        provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'item/completed:fileChange' },
      },
      timestamp: occurredAt,
    };
  }

  // F045: mcp_tool_call completed → tool_result (+ F060: optional rich_block for images)
  if (item?.type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : 'unknown';
    const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
    const status = typeof item.status === 'string' ? item.status : 'completed';
    const result = item.result as Record<string, unknown> | undefined;
    const itemError = item.error as Record<string, unknown> | undefined;
    const contentArr = Array.isArray(result?.content) ? result.content : [];
    const typed = contentArr as Array<Record<string, unknown>>;
    const textParts = typed.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);
    const resultError =
      typeof result?.Err === 'string'
        ? result.Err
        : (status === 'failed' || status === 'error') && typeof itemError?.message === 'string'
          ? itemError.message
          : status === 'failed' || status === 'error'
            ? textParts.length === 1
              ? textParts[0]
              : undefined
            : undefined;
    const approvalFailure = resultError
      ? classifyCodexGithubAppApprovalFailure({
          server,
          tool,
          error: resultError,
          approvalSurface: options?.approvalSurface,
        })
      : null;
    const visibleTextParts = approvalFailure
      ? [`[${approvalFailure.reasonCode}] ${approvalFailure.message}`]
      : textParts.length > 0
        ? textParts
        : resultError
          ? [resultError]
          : [];

    const toolLabel = `mcp:${server}/${tool}`;
    // F153 Phase J AC-J2: map Codex item.status → structured ToolResultStatus + carry item.id.
    const toolResultStatus: 'ok' | 'error' | 'unknown' =
      status === 'completed' ? 'ok' : status === 'failed' || status === 'error' ? 'error' : 'unknown';
    const toolResult: AgentMessage = {
      type: 'tool_result',
      catId,
      content: `${toolLabel} (${status})\n${visibleTextParts.join('\n')}`.trim(),
      toolName: toolLabel,
      toolSource: 'mcp',
      toolChannel: 'unknown',
      toolResultStatus,
      ...(approvalFailure ? { toolResultErrorCode: approvalFailure.reasonCode } : {}),
      timestamp: Date.now(),
    };
    if (typeof item.id === 'string') toolResult.toolUseId = item.id;

    // F060: Extract image content blocks → media_gallery rich block
    // P2 fix: mimeType whitelist + base64 size guard
    const imageItems = typed
      .filter(
        (c) =>
          c.type === 'image' &&
          typeof c.data === 'string' &&
          typeof c.mimeType === 'string' &&
          IMAGE_MIME_WHITELIST.has(c.mimeType as string) &&
          (c.data as string).length <= MAX_BASE64_LENGTH,
      )
      .map((c) => ({
        url: `data:${c.mimeType as string};base64,${c.data as string}`,
        alt: 'MCP tool output image',
      }));

    if (imageItems.length === 0) {
      return toolResult;
    }

    const richBlock: AgentMessage = {
      type: 'system_info',
      catId,
      content: JSON.stringify({
        type: 'rich_block',
        block: {
          id: `mcp-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'media_gallery',
          v: 1,
          title: toolLabel,
          items: imageItems,
        },
      }),
      timestamp: Date.now(),
    };

    return [toolResult, richBlock];
  }

  // F045: web_search → system_info — count only, no query (privacy)
  if (item?.type === 'web_search') {
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'web_search', catId, count: 1 }),
      timestamp: Date.now(),
    };
  }

  // F045: item-level error → system_info(warning)
  if (item?.type === 'error' && typeof item.message === 'string') {
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'warning', catId, message: item.message }),
      timestamp: Date.now(),
    };
  }

  return null;
}

function isCodexGoalStatus(value: unknown): value is import('../../types.js').ProviderNativeGoalStatus {
  return ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(String(value));
}
