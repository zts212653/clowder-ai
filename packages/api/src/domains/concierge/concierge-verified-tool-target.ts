/**
 * F229 verified tool-result action provenance.
 *
 * A concierge model may find a better target after the pre-invocation handle
 * table was built. This collector preserves only explicit, successful
 * `get_thread_context` reads from that invocation. Search candidates and
 * unpaired/malformed tool output never become navigation authority.
 */

import type { HandleAnchor } from './concierge-search-context.js';

const THREAD_CONTEXT_TOOL_NAME = 'get_thread_context';
const TRUSTED_THREAD_CONTEXT_SERVERS = new Set([
  'cat-cafe',
  'cat-cafe-collab',
  'cat_cafe',
  'cat_cafe_collab',
  'codex_apps',
]);

interface ConciergeToolEvent {
  type: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResultStatus?: 'ok' | 'error' | 'unknown';
  content?: string;
}

interface PendingThreadContextRead {
  threadId: string;
  messageId?: string;
  toolUseId?: string;
}

export interface VerifiedConciergeToolTarget {
  threadId: string;
  messageId?: string;
}

export interface ConciergeThreadTitleLookup {
  get(
    threadId: string,
  ):
    | { id: string; title: string | null; deletedAt?: number | null }
    | null
    | Promise<{ id: string; title: string | null; deletedAt?: number | null } | null>;
}

function normalizeToolName(rawToolName: string | undefined): string | undefined {
  if (!rawToolName) return undefined;
  let name = rawToolName;
  let server: string | undefined;
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.slice(5);
    const separator = withoutPrefix.indexOf('__');
    if (separator < 0) return undefined;
    server = withoutPrefix.slice(0, separator);
    name = withoutPrefix.slice(separator + 2);
  } else if (name.startsWith('mcp:')) {
    const withoutPrefix = name.slice(4);
    const separator = withoutPrefix.indexOf('/');
    if (separator < 0) return undefined;
    server = withoutPrefix.slice(0, separator);
    name = withoutPrefix.slice(separator + 1);
  }
  if (server && !TRUSTED_THREAD_CONTEXT_SERVERS.has(server)) return undefined;
  while (name.startsWith('cat_cafe_')) name = name.slice('cat_cafe_'.length);
  return name;
}

function inferResultToolName(event: ConciergeToolEvent): string | undefined {
  if (event.toolName) return normalizeToolName(event.toolName);
  const firstLine = event.content?.trimStart().split('\n', 1)[0]?.trim();
  const match = firstLine?.match(/^(mcp:[^\s]+)\s+\(/);
  return normalizeToolName(match?.[1]);
}

function parseThreadContextResult(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  const firstObject = content.indexOf('{');
  if (firstObject < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(firstObject)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resultMatchesPendingRead(payload: Record<string, unknown>, pending: PendingThreadContextRead): boolean {
  if (payload.threadId !== pending.threadId) return false;
  if (!pending.messageId) return true;
  if (!Array.isArray(payload.messages)) return false;
  return payload.messages.some(
    (message) =>
      message != null &&
      typeof message === 'object' &&
      (message as Record<string, unknown>).id === pending.messageId &&
      (message as Record<string, unknown>).threadId === pending.threadId,
  );
}

/** Invocation-local collector; create one per responding cat. */
export class VerifiedConciergeToolTargetCollector {
  private readonly pending: PendingThreadContextRead[] = [];
  private readonly verified = new Map<string, VerifiedConciergeToolTarget>();

  observe(event: ConciergeToolEvent): void {
    if (event.type === 'tool_use') {
      this.observeToolUse(event);
      return;
    }
    if (event.type === 'tool_result') this.observeToolResult(event);
  }

  reset(): void {
    this.pending.splice(0, this.pending.length);
    this.verified.clear();
  }

  uniqueTarget(): VerifiedConciergeToolTarget | undefined {
    if (this.verified.size !== 1) return undefined;
    return this.verified.values().next().value;
  }

  verifiedTargetCount(): number {
    return this.verified.size;
  }

  private observeToolUse(event: ConciergeToolEvent): void {
    if (normalizeToolName(event.toolName) !== THREAD_CONTEXT_TOOL_NAME) return;
    const threadId = event.toolInput?.threadId;
    if (typeof threadId !== 'string' || !threadId.trim()) return;
    const messageId = event.toolInput?.messageId;
    this.pending.push({
      threadId,
      ...(typeof messageId === 'string' && messageId ? { messageId } : {}),
      ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
    });
  }

  private observeToolResult(event: ConciergeToolEvent): void {
    const pendingIndex = this.findPendingIndex(event);
    if (pendingIndex < 0) return;
    const [pending] = this.pending.splice(pendingIndex, 1);
    if (!pending || event.toolResultStatus !== 'ok') return;

    const payload = parseThreadContextResult(event.content);
    if (!payload || !resultMatchesPendingRead(payload, pending)) return;

    const previous = this.verified.get(pending.threadId);
    if (!previous) {
      this.verified.set(pending.threadId, {
        threadId: pending.threadId,
        ...(pending.messageId ? { messageId: pending.messageId } : {}),
      });
      return;
    }

    // Two verified reads of the same thread still identify one target. If they
    // point at different messages, degrade to thread-level navigation rather
    // than choosing an arbitrary scroll anchor.
    if (previous.messageId !== pending.messageId) {
      this.verified.set(pending.threadId, { threadId: pending.threadId });
    }
  }

  private findPendingIndex(event: ConciergeToolEvent): number {
    if (event.toolUseId) {
      return this.pending.findIndex((entry) => entry.toolUseId === event.toolUseId);
    }
    if (inferResultToolName(event) !== THREAD_CONTEXT_TOOL_NAME) return -1;
    // Without a lifecycle id, only one outstanding matching read is safe to
    // pair. Concurrent same-tool calls are ambiguous and fail closed.
    return this.pending.length === 1 ? 0 : -1;
  }
}

/** Hydrate a unique verified target with the canonical thread title. */
export async function resolveVerifiedConciergeToolAnchor(
  collector: VerifiedConciergeToolTargetCollector | undefined,
  currentThreadId: string,
  threadLookup: ConciergeThreadTitleLookup | null | undefined,
): Promise<HandleAnchor | undefined> {
  const target = collector?.uniqueTarget();
  if (!target || target.threadId === currentThreadId || !threadLookup) return undefined;

  const thread = await threadLookup.get(target.threadId);
  const title = thread?.title?.trim();
  if (!thread || thread.id !== target.threadId || thread.deletedAt != null || !title) return undefined;

  return {
    threadId: target.threadId,
    ...(target.messageId ? { messageId: target.messageId } : {}),
    title,
    type: 'thread',
  };
}
