/**
 * F153 Phase J Slice J-A AC-J3: ToolSpanTracker per-invocation.
 *
 * Replaces the zero-duration point-marker behavior of `recordToolUseSpan`
 * with real-duration spans bounded by `tool_use` start and `tool_result` end.
 *
 * Scope (KD-37): one tracker per (invocation, cat). Internal map keyed by
 * `toolUseId`; the tracker instance scope naturally prevents cross-invocation
 * provider-raw-id collisions.
 *
 * Lifecycle:
 * - `start(toolName, toolUseId, input)` → creates an open child span on the
 *   invocation span. Basic (non-MCP) tools bypass span creation and bump the
 *   `tool.basic_call_count` counter on the invocation span instead.
 * - `end(toolUseId, status)` → closes the span with status from
 *   `toolResultStatus` (KD-38). No-op when toolUseId is unknown.
 *   Deliberately does NOT accept a result body / metadata parameter —
 *   keeps tool result bodies out of span attrs (Phase J Out-of-scope boundary).
 * - `endAllOrphans(reason)` → AC-J4 finally cleanup. Called from invocation
 *   lifecycle finally block to drain spans whose `tool_result` never arrived
 *   (abort/error/timeout).
 */

import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { isMcpToolName } from '../../domains/cats/services/tool-usage/classify.js';
import { AGENT_ID, TOOL_CATEGORY, TOOL_INPUT_KEYS, TOOL_NAME } from './genai-semconv.js';
import { recordToolUseSpan } from './span-helpers.js';

const tracer = trace.getTracer('cat-cafe-api', '0.1.0');

const MEMORY_TOOL_PREFIXES = [
  'cat_cafe_search_evidence',
  'cat_cafe_read_session',
  'cat_cafe_read_invocation',
  'cat_cafe_review_distillation',
];

function classifyToolCategory(toolName: string): string | undefined {
  if (MEMORY_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'memory';
  return undefined;
}

export type ToolResultStatus = 'ok' | 'error' | 'unknown';

export class ToolSpanTracker {
  private spans = new Map<string, Span>();

  constructor(
    private readonly invocationSpan: Span,
    private readonly catId: string,
  ) {}

  /**
   * Start a tool_use span. Returns the span for advanced callers, or `undefined`
   * for basic tools (which bump the invocation-span counter and emit no child span).
   *
   * Basic-tool path delegates to `recordToolUseSpan` from `span-helpers.ts` so
   * the `tool.basic_call_count` WeakMap state is shared with the legacy fallback
   * call site (KD-40 + R1 fix per cloud Codex: prevents undercount during the
   * partial-wiring migration window when some msg path goes through tracker and
   * some through legacy).
   *
   * Duplicate `start(toolUseId)` is a no-op (re-emitted event); returns existing span.
   */
  start(toolName: string, toolUseId: string, toolInput?: Record<string, unknown>): Span | undefined {
    if (!isMcpToolName(toolName)) {
      // Delegate to shared WeakMap in span-helpers.ts (counter state unified)
      recordToolUseSpan(this.invocationSpan, this.catId, toolName, toolInput);
      return undefined;
    }

    const existing = this.spans.get(toolUseId);
    if (existing) return existing;

    const parentCtx = trace.setSpan(context.active(), this.invocationSpan);
    const category = classifyToolCategory(toolName);
    const span = tracer.startSpan(
      `cat_cafe.tool_use ${toolName}`,
      {
        attributes: {
          [AGENT_ID]: this.catId,
          [TOOL_NAME]: toolName,
          ...(toolInput ? { [TOOL_INPUT_KEYS]: Object.keys(toolInput).join(',') } : {}),
          ...(category ? { [TOOL_CATEGORY]: category } : {}),
          'tool.use_id': toolUseId,
        },
      },
      parentCtx,
    );
    this.spans.set(toolUseId, span);
    return span;
  }

  /**
   * Close a tool_use span with the given status. No-op when toolUseId is
   * unknown (either a basic tool that bypassed span creation, or a `tool_result`
   * without a matching `tool_use`).
   *
   * Per Phase J spec "Out of scope: Tool input/result body 写入 span attr — 保持
   * 低敏，只存 keys + status, 不存正文" — does NOT accept a resultMeta blob.
   * Only the structured `status` is attached as an attribute.
   */
  end(toolUseId: string, status: ToolResultStatus): void {
    const span = this.spans.get(toolUseId);
    if (!span) return;

    span.setAttribute('tool.result.status', status);
    if (status === 'ok') {
      span.setStatus({ code: SpanStatusCode.OK });
    } else if (status === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
    this.spans.delete(toolUseId);
  }

  /**
   * AC-J4: end all currently-open spans, marking them with the given lifecycle reason.
   * Called from invocation lifecycle finally block on abort/error/timeout to
   * prevent orphan spans (mirrors PR #732 mention_dispatch abort-safety pattern).
   */
  endAllOrphans(reason: 'aborted' | 'completed' = 'aborted'): void {
    for (const span of this.spans.values()) {
      span.setAttribute('tool.lifecycle', reason);
      span.end();
    }
    this.spans.clear();
  }

  /** Number of currently-open tool spans (for diagnostics / tests). */
  size(): number {
    return this.spans.size;
  }
}
