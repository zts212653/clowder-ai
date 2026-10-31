import {
  writeCliDiagnostics,
  writeMessageMetadata,
  writePostRichBlock,
  writeRichBlock,
  writeThinking,
  writeToolEvent,
} from '@/hooks/named-message-writer';
import { servedFactsFromUsagePayload } from '@/lib/served-model-facts';
import type { RichBlock, TokenUsage } from '@/stores/chat-types';
import { formatVisibleSystemInfo, isSystemInfoProtocolPayload } from '../system-info-visible';
import { dropUnnamedBodyWrite, isLateForCommittedResponse, namedTarget, touchStreamActivity } from './named-target';
import type { SystemInfoPort } from './system-info-port';
import { projectStatusSystemInfo } from './system-info-status';
import {
  isRecord,
  resolveSemanticSystemMessage,
  retainSystemInfo,
  stringField,
  upsertSystemRow,
} from './system-projections';
import { webSearchEvent } from './tool-events';
import type { AgentEventFields, SystemInfoConsumeResult } from './types';

type SystemInfoEvent = AgentEventFields & { timestamp?: number };

/**
 * Project one `system_info` event through `port`. Body subtypes (thinking, rich_block, web_search,
 * invocation_usage) write into the message the event names; everything else is status or a system
 * row with its own id. Returns whether the event was consumed, or the visible copy the caller shows
 * as a system row.
 */
export function consumeSystemInfo(msg: SystemInfoEvent, port: SystemInfoPort): SystemInfoConsumeResult {
  const out: SystemInfoConsumeResult = { consumed: false, content: msg.content ?? '', variant: 'info' };
  let protocolPayload = false;
  try {
    const parsed: unknown = JSON.parse(out.content);
    protocolPayload = isSystemInfoProtocolPayload(parsed);
    if (isRecord(parsed)) projectPayload(parsed, msg, port, out);
  } catch (error) {
    if (msg.type === 'provider_signal') {
      out.consumed = true;
      if (msg.content && !isLateForCommittedResponse(msg, port.threadId, port.store()))
        port.setCatStatus(msg.catId, 'spawning', msg.content);
      return out;
    }
    // A recognized protocol envelope stays hidden even when its projector fails; the failure is a
    // diagnostic. Plain text that does not parse stays on the visible fallback path.
    if (protocolPayload) out.consumed = true;
    if (out.consumed) {
      console.warn(`[system_info] ${port.path} internal projection failed; payload suppressed`, {
        catId: msg.catId,
        threadId: port.threadId,
        error,
      });
    }
  }
  // Typed envelopes need an explicit readable formatter (`systemInfo`) or an internal projector:
  // an unknown future protocol payload is silent by default.
  if (protocolPayload && !out.systemInfo) out.consumed = true;
  return out;
}

function projectPayload(
  parsed: Record<string, unknown>,
  msg: SystemInfoEvent,
  port: SystemInfoPort,
  out: SystemInfoConsumeResult,
): void {
  if (parsed.type === 'silent_completion') {
    const target = namedTarget(msg, port.threadId);
    if (target && msg.metadata?.cliDiagnostics && !isLateForCommittedResponse(msg, port.threadId, port.store()))
      writeCliDiagnostics(target, msg.metadata.cliDiagnostics, port.store);
    out.consumed = true;
    return;
  }
  const visible = formatVisibleSystemInfo(parsed, port.resolveCatName);
  if (visible) {
    out.content = visible.content;
    out.variant = visible.variant;
    out.systemInfo = retainSystemInfo(parsed, msg.catId);
    return;
  }
  if (projectBodySystemInfo(parsed, msg, port) || projectStatusSystemInfo(parsed, msg, port)) {
    out.consumed = true;
    return;
  }
  if (parsed.type === 'session_seal_requested') {
    // Client-internal continuity: update the existing invocation, never create a result row.
    const sealedCatId = stringField(parsed, 'catId');
    if (!sealedCatId) return;
    port.setCatInvocation(sealedCatId, { sessionSeq: parsed.sessionSeq as number | undefined, sessionSealed: true });
    out.consumed = true;
  }
}

type BodyProjector = (parsed: Record<string, unknown>, msg: SystemInfoEvent, port: SystemInfoPort) => void;

/**
 * Telemetry, never user-facing. The footer of the named message is the visible truth and the
 * cat-level snapshot is secondary. Metadata goes first: usage lands inside metadata.
 */
const writeInvocationUsage: BodyProjector = (parsed, msg, port) => {
  const usage = parsed.usage as TokenUsage | undefined;
  const target = namedTarget(msg, port.threadId);
  if (target) {
    const model = stringField(parsed, 'model');
    const provider = stringField(parsed, 'provider');
    writeMessageMetadata(
      target,
      {
        ...(model && provider ? { metadata: { model, provider } } : {}),
        ...(usage ? { usage } : {}),
        served: servedFactsFromUsagePayload(parsed),
      },
      port.store,
    );
  }
  port.setCatInvocation(msg.catId, { usage });
};

/** F045: a web search is a tool call row (privacy: the count only, never the query). */
const writeWebSearch: BodyProjector = (parsed, msg, port) => {
  if (isLateForCommittedResponse(msg, port.threadId, port.store())) return;
  if (port.path === 'active') port.setCatStatus(msg.catId, 'streaming');
  const target = namedTarget(msg, port.threadId);
  if (!target) {
    dropUnnamedBodyWrite('web_search', msg, port.threadId);
    return;
  }
  const count = typeof parsed.count === 'number' ? parsed.count : 1;
  const event = webSearchEvent({ id: port.newId('web-search'), catId: msg.catId, count, timestamp: port.createdAt });
  writeToolEvent(target, event, port.store);
  touchStreamActivity(port.store(), port.threadId, target.messageId);
};

/** F045: thinking is embedded in the named message; the writer dedupes repeated chunks. */
const writeThinkingChunk: BodyProjector = (parsed, msg, port) => {
  const thinking = typeof parsed.text === 'string' ? parsed.text : '';
  if (!thinking) return;
  const target = namedTarget(msg, port.threadId);
  if (!target) {
    dropUnnamedBodyWrite('thinking', msg, port.threadId);
    return;
  }
  writeThinking(target, thinking, port.store);
  touchStreamActivity(port.store(), port.threadId, target.messageId);
};

/**
 * F22: a post's own block names that post in its payload (`messageId`) and lands there without
 * reopening it; any other block belongs to the message the event names (the turn's response).
 */
const writeRichBlockEvent: BodyProjector = (parsed, msg, port) => {
  const block = parsed.block as RichBlock | undefined;
  if (!block) return;
  const postId = stringField(parsed, 'messageId');
  if (postId) {
    writePostRichBlock({ threadId: port.threadId, messageId: postId }, block, port.store);
    return;
  }
  const target = namedTarget(msg, port.threadId);
  if (!target) {
    dropUnnamedBodyWrite('rich_block', msg, port.threadId);
    return;
  }
  writeRichBlock(target, block, port.store);
  touchStreamActivity(port.store(), port.threadId, target.messageId);
};

const BODY_PROJECTORS = new Map<string, BodyProjector>([
  ['invocation_usage', writeInvocationUsage],
  ['web_search', writeWebSearch],
  ['thinking', writeThinkingChunk],
  ['rich_block', writeRichBlockEvent],
]);

/** Body subtypes write into exactly the message the event names, through the named writer. */
function projectBodySystemInfo(parsed: Record<string, unknown>, msg: SystemInfoEvent, port: SystemInfoPort): boolean {
  const project = typeof parsed.type === 'string' ? BODY_PROJECTORS.get(parsed.type) : undefined;
  if (!project) return false;
  project(parsed, msg, port);
  return true;
}

/**
 * F306 provider semantic events. A subexecution event projects its child executions onto the
 * message it names as metadata (never a body). A `replace` resolution owns a `semantic:*` row.
 * Returns true when the event is fully handled and must not continue as its own type.
 */
export function applySemanticEvent(msg: SystemInfoEvent, port: SystemInfoPort): boolean {
  if (!msg.semanticEvent) return false;
  if (msg.semanticEvent.kind === 'subexecution' && msg.metadata?.subexecutionEvents?.length) {
    const target = namedTarget(msg, port.threadId);
    if (target) writeMessageMetadata(target, { metadata: msg.metadata }, port.store);
    else dropUnnamedBodyWrite('subexecution', msg, port.threadId);
  }
  const semantic = resolveSemanticSystemMessage(msg);
  if (semantic.action === 'replace') upsertSystemRow(port, semantic.message, semantic.message);
  return semantic.action !== 'augment';
}
