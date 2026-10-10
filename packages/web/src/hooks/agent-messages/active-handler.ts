import { writePersistedPost, writeStreamText, writeToolEvent } from '@/hooks/named-message-writer';
import type { ToolEvent } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { type ActiveContext, activeSystemInfoPort, openThreadStore } from './active-context';
import { handleActiveDone, handleActiveError } from './active-terminal';
import {
  callbackPost,
  dropUnnamedBodyWrite,
  isLateForCommittedResponse,
  namedTarget,
  ownSystemRowId,
  streamTextWrite,
  touchStreamActivity,
} from './named-target';
import { applySemanticEvent, consumeSystemInfo } from './system-info';
import { appServerLifecycleFromStatus, appServerStageStatus, isAppServerRecoveryStatus } from './system-projections';
import { randomIdSuffix, skipFileChangeCard, toolResultEvent, toolUseEvent } from './tool-events';
import type { AgentMsg } from './types';

/**
 * Open-thread entry. Every body event is written into the message it names (`msg.messageId`) by the
 * named-message writer; status, slots and system rows use the open thread's flat actions.
 */
export function handleActiveAgentMessage(msg: AgentMsg, ctx: ActiveContext): void {
  const threadId = msg.threadId ?? useChatStore.getState().currentThreadId;
  if (msg.semanticEvent && applySemanticEvent(msg, activeSystemInfoPort(threadId, ctx))) return;

  switch (msg.type) {
    case 'status':
      handleActiveStatus(msg, ctx);
      break;
    case 'text':
      if (!isLateForCommittedResponse(msg, threadId, openThreadStore())) handleActiveText(msg, threadId, ctx);
      break;
    case 'tool_use':
      if (!isLateForCommittedResponse(msg, threadId, openThreadStore())) handleActiveToolUse(msg, threadId, ctx);
      break;
    case 'tool_result':
      if (!isLateForCommittedResponse(msg, threadId, openThreadStore())) handleActiveToolResult(msg, threadId, ctx);
      break;
    case 'done':
      handleActiveDone(msg, threadId, ctx);
      break;
    case 'error':
      handleActiveError(msg, threadId, ctx);
      break;
    case 'provider_signal':
      handleActiveSystemInfo(msg, threadId, ctx);
      break;
    case 'system_info':
      handleActiveSystemInfo(msg, threadId, ctx);
      break;
    default:
      // Retired projections (e.g. a2a_handoff) carry nothing the open thread shows.
      break;
  }
}

function handleActiveStatus(msg: AgentMsg, ctx: ActiveContext): void {
  const lifecycle = appServerLifecycleFromStatus(msg.metadata);
  if (lifecycle) {
    const status = appServerStageStatus(lifecycle.stage);
    if (status) ctx.actions.setCatStatus(msg.catId, status);
    ctx.actions.setCatInvocation(msg.catId, { appServerLifecycle: lifecycle });
    return;
  }
  if (isAppServerRecoveryStatus(msg.metadata)) ctx.actions.setCatStatus(msg.catId, 'spawning');
}

function handleActiveText(msg: AgentMsg, threadId: string, ctx: ActiveContext): void {
  if (!msg.content) return;
  ctx.actions.setCatStatus(msg.catId, 'streaming');
  // F118: output resumed, so the liveness warning no longer applies.
  ctx.actions.setCatInvocation(msg.catId, { livenessWarning: undefined });

  if (msg.origin === 'callback') {
    // A post_message is its own persisted message beside the response; a replay adds nothing.
    const post = callbackPost(msg, msg.timestamp ?? Date.now());
    if (post) writePersistedPost(post, threadId);
    else dropUnnamedBodyWrite('callback', msg, threadId);
    return;
  }
  const target = namedTarget(msg, threadId);
  if (!target) {
    dropUnnamedBodyWrite('text', msg, threadId);
    return;
  }
  writeStreamText(target, streamTextWrite(msg));
  touchStreamActivity(openThreadStore(), threadId, target.messageId);
}

function handleActiveToolUse(msg: AgentMsg, threadId: string, ctx: ActiveContext): void {
  ctx.actions.setCatStatus(msg.catId, 'streaming');
  const event = toolUseEvent({
    id: `tool-${Date.now()}-${randomIdSuffix()}`,
    catId: msg.catId,
    toolName: msg.toolName,
    toolInput: msg.toolInput,
    timestamp: Date.now(),
  });
  const isFileChange = msg.toolName === 'file_change';
  if (isFileChange && skipFileChangeCard(msg.catId, event.detail)) return;
  if (writeActiveToolEvent(msg, threadId, event) && isFileChange) {
    console.info('[agent_message] file_change tool_use appended', { catId: msg.catId, messageId: msg.messageId });
  }
}

function handleActiveToolResult(msg: AgentMsg, threadId: string, ctx: ActiveContext): void {
  ctx.actions.setCatStatus(msg.catId, 'streaming');
  const event = toolResultEvent({
    id: `toolr-${Date.now()}-${randomIdSuffix()}`,
    catId: msg.catId,
    content: msg.content,
    timestamp: Date.now(),
  });
  writeActiveToolEvent(msg, threadId, event);
}

function writeActiveToolEvent(msg: AgentMsg, threadId: string, event: ToolEvent): boolean {
  const target = namedTarget(msg, threadId);
  if (!target) {
    dropUnnamedBodyWrite(event.type, msg, threadId);
    return false;
  }
  writeToolEvent(target, event);
  touchStreamActivity(openThreadStore(), threadId, target.messageId);
  return true;
}

function handleActiveSystemInfo(msg: AgentMsg, threadId: string, ctx: ActiveContext): void {
  const result = consumeSystemInfo(msg, activeSystemInfoPort(threadId, ctx));
  if (result.consumed) return;
  const cliDiagnostics = msg.metadata?.cliDiagnostics;
  const extra =
    result.systemInfo || cliDiagnostics
      ? {
          ...(result.systemInfo ? { systemInfo: result.systemInfo } : {}),
          ...(cliDiagnostics ? { cliDiagnostics } : {}),
        }
      : undefined;
  // A persisted routing receipt keeps its own stored id; it never takes a response's id.
  const ownId =
    result.systemInfo?.payload.type === 'routing_preflight'
      ? ownSystemRowId(msg.messageId, useChatStore.getState().messages)
      : undefined;
  ctx.rows.addRow({
    id: ownId ?? `sysinfo-${Date.now()}-${randomIdSuffix()}`,
    type: 'system',
    variant: result.variant,
    content: result.content,
    timestamp: Date.now(),
    ...(extra ? { extra } : {}),
  });
}
