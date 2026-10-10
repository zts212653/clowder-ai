import {
  finishNamedMessage,
  type NamedMessageStore,
  writePersistedPost,
  writeStreamText,
  writeToolEvent,
} from '@/hooks/named-message-writer';
import type { CatStatusType } from '@/stores/chat-types';
import { invocationErrorRowId, isRecoverableInFlightError, upsertErrorRow } from './error-rows';
import { isStaleTerminalEvent, markThreadInvocationActive, markThreadInvocationComplete } from './invocation-slots';
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
import type { SystemInfoPort } from './system-info-port';
import {
  appServerLifecycleFromStatus,
  appServerStageStatus,
  isAppServerRecoveryStatus,
  type SystemRowSink,
} from './system-projections';
import { toolResultEvent, toolUseEvent } from './tool-events';
import type { BackgroundAgentMessage, HandleBackgroundMessageOptions, SystemInfoConsumeResult } from './types';

/**
 * Background-thread entry. Message writes go through the same named-message writer as the open
 * thread (it routes by threadId and counts unread when a message first gains a body); status,
 * slots, toasts and rows use the thread-scoped store.
 */

const BACKGROUND_STATUS_MAP: Record<string, CatStatusType> = {
  streaming: 'streaming',
  thinking: 'pending',
  done: 'done',
};

type Options = HandleBackgroundMessageOptions;

function catName(options: Options, catId: string): string {
  return options.resolveCatName?.(catId) ?? catId;
}

function writerStore(options: Options): () => NamedMessageStore {
  return () => options.store;
}

function rowSink(msg: BackgroundAgentMessage, options: Options): SystemRowSink {
  return {
    rows: () => options.store.getThreadState(msg.threadId).messages,
    addRow: (row) => options.store.addMessageToThread(msg.threadId, row),
    patchRow: (id, patch) => options.store.patchThreadMessage(msg.threadId, id, patch),
  };
}

function systemInfoPort(msg: BackgroundAgentMessage, options: Options): SystemInfoPort {
  const { store } = options;
  return {
    ...rowSink(msg, options),
    path: 'background',
    threadId: msg.threadId,
    store: writerStore(options),
    resolveCatName: (catId) => catName(options, catId),
    createdAt: msg.timestamp,
    newId: (kind) =>
      kind === 'web-search'
        ? `bg-web-search-${msg.timestamp}-${options.nextBgSeq()}`
        : `gov-blocked-${msg.timestamp}-${options.nextBgSeq()}`,
    catInvocation: (catId) => store.getThreadState(msg.threadId).catInvocations?.[catId],
    setCatStatus: (catId, status, detail) => {
      if (detail) store.updateThreadCatStatus(msg.threadId, catId, status, detail);
      else store.updateThreadCatStatus(msg.threadId, catId, status);
    },
    setCatInvocation: (catId, info) => store.setThreadCatInvocation(msg.threadId, catId, info),
    removeRow: (id) => store.removeThreadMessage(msg.threadId, id),
  };
}

/** A background `system_info`: status and rows, plus body subtypes written into the message they name. */
export function consumeBackgroundSystemInfo(msg: BackgroundAgentMessage, options: Options): SystemInfoConsumeResult {
  return consumeSystemInfo(msg, systemInfoPort(msg, options));
}

export function handleBackgroundAgentMessage(msg: BackgroundAgentMessage, options: Options): void {
  if (msg.semanticEvent && applySemanticEvent(msg, systemInfoPort(msg, options))) return;
  const isStreamOutput = msg.type === 'text' || msg.type === 'tool_use' || msg.type === 'tool_result';
  // A late stream event for a committed response must not reopen the thread's activity or slots.
  if (isStreamOutput && isLateForCommittedResponse(msg, msg.threadId, options.store)) return;
  switch (msg.type) {
    case 'text':
      handleText(msg, options);
      break;
    case 'error':
      handleError(msg, options);
      break;
    case 'done':
      handleDone(msg, options);
      break;
    case 'status':
      handleStatus(msg, options);
      break;
    case 'tool_use':
    case 'tool_result':
      handleTool(msg, options);
      break;
    case 'provider_signal':
    case 'system_info':
      handleSystemInfo(msg, options);
      break;
    default:
      break;
  }
}

function handleText(msg: BackgroundAgentMessage, options: Options): void {
  if (!msg.content) return;
  const { store } = options;
  let finalMessageId: string | undefined;
  if (msg.origin === 'callback') {
    // A post_message is its own persisted message beside the response; a replay adds nothing.
    const post = callbackPost(msg, msg.timestamp);
    if (post) {
      writePersistedPost(post, msg.threadId, writerStore(options));
      finalMessageId = post.id;
    } else {
      dropUnnamedBodyWrite('callback', msg, msg.threadId);
    }
    if (msg.isFinal) store.updateThreadCatStatus(msg.threadId, msg.catId, 'done');
  } else {
    markThreadInvocationActive(msg, options);
    const target = namedTarget(msg, msg.threadId);
    if (target) {
      writeStreamText(target, streamTextWrite(msg), writerStore(options));
      touchStreamActivity(store, msg.threadId, target.messageId);
      if (msg.isFinal) finishNamedMessage(target, writerStore(options));
      finalMessageId = target.messageId;
    } else {
      dropUnnamedBodyWrite('text', msg, msg.threadId);
    }
    store.updateThreadCatStatus(msg.threadId, msg.catId, msg.isFinal ? 'done' : 'streaming');
  }
  if (!msg.isFinal) return;

  // Completion uses the original response; the toast only notifies another thread.
  const finalMessage = finalMessageId
    ? store.getThreadState(msg.threadId).messages.find((message) => message.id === finalMessageId)
    : undefined;
  const preview = finalMessage?.content ?? msg.content;
  markThreadInvocationComplete(msg, options);
  options.addToast({
    type: 'success',
    title: `${catName(options, msg.catId)} 完成`,
    message: preview,
    threadId: msg.threadId,
    duration: 5000,
  });
}

/** F117 error rule: an error naming the response writes no row; the response carries the failure. */
function handleError(msg: BackgroundAgentMessage, options: Options): void {
  const { store } = options;
  const recoverable = isRecoverableInFlightError(msg);
  const before = store.getThreadState(msg.threadId);
  const stale = isStaleTerminalEvent(
    before.activeInvocations,
    before.catInvocations,
    msg.catId,
    msg.invocationId,
    msg.turnInvocationId,
  );
  const target = namedTarget(msg, msg.threadId);
  if (target && !recoverable) finishNamedMessage(target, writerStore(options));
  if (stale) return;
  markThreadInvocationActive(msg, options);
  if (!target) {
    // No admitted response: the row is the only carrier (F212: with its CLI diagnostics panel).
    // A new row in a background thread counts one unread; a repeated error updates it in place.
    const cliDiagnostics = msg.metadata?.cliDiagnostics;
    upsertErrorRow(rowSink(msg, options), {
      id: invocationErrorRowId(msg) ?? `bg-err-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
      type: 'system',
      variant: 'error',
      catId: msg.catId,
      content: `Error: ${msg.error ?? 'Unknown error'}`,
      timestamp: msg.timestamp,
      ...(cliDiagnostics ? { extra: { cliDiagnostics } } : {}),
    });
  }
  if (!recoverable) store.updateThreadCatStatus(msg.threadId, msg.catId, 'error');
  if (msg.isFinal) {
    markThreadInvocationComplete(msg, options);
  }
  options.addToast({
    type: 'error',
    title: `${catName(options, msg.catId)} 出错`,
    message: msg.error ?? 'Unknown error',
    threadId: msg.threadId,
    duration: 8000,
  });
}

function handleDone(msg: BackgroundAgentMessage, options: Options): void {
  // done ends the named response's streaming but never writes its body: the committed snapshot
  // (published at each target's done) is the truth; an empty `done.content` must not wipe it.
  const target = namedTarget(msg, msg.threadId);
  if (target) finishNamedMessage(target, writerStore(options));
  const before = options.store.getThreadState(msg.threadId);
  if (
    isStaleTerminalEvent(
      before.activeInvocations,
      before.catInvocations,
      msg.catId,
      msg.invocationId,
      msg.turnInvocationId,
    )
  )
    return;
  // An error already reported this turn: done keeps it and shows no success toast.
  if (options.store.getThreadState(msg.threadId).catStatuses[msg.catId] !== 'error') {
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'done');
    options.addToast({
      type: 'success',
      title: `${catName(options, msg.catId)} 完成`,
      message: `${catName(options, msg.catId)} 已完成处理`,
      threadId: msg.threadId,
      duration: 5000,
    });
  }
  if (msg.isFinal) {
    markThreadInvocationComplete(msg, options);
  }
}

function handleStatus(msg: BackgroundAgentMessage, options: Options): void {
  const { store } = options;
  const lifecycle = appServerLifecycleFromStatus(msg.metadata);
  if (lifecycle) {
    const status = appServerStageStatus(lifecycle.stage);
    if (status) store.updateThreadCatStatus(msg.threadId, msg.catId, status);
    store.setThreadCatInvocation(msg.threadId, msg.catId, { appServerLifecycle: lifecycle });
    return;
  }
  if (isAppServerRecoveryStatus(msg.metadata)) {
    store.updateThreadCatStatus(msg.threadId, msg.catId, 'spawning');
    return;
  }
  const mapped = BACKGROUND_STATUS_MAP[msg.content ?? ''] ?? 'streaming';
  const detail = msg.content && !BACKGROUND_STATUS_MAP[msg.content] ? msg.content : undefined;
  store.updateThreadCatStatus(msg.threadId, msg.catId, mapped, detail);
}

function handleTool(msg: BackgroundAgentMessage, options: Options): void {
  markThreadInvocationActive(msg, options);
  const kind = msg.type === 'tool_use' ? 'use' : 'result';
  const id = `bg-tool-${kind}-${msg.timestamp}-${options.nextBgSeq()}`;
  const event =
    msg.type === 'tool_use'
      ? toolUseEvent({
          id,
          catId: msg.catId,
          toolName: msg.toolName,
          toolInput: msg.toolInput,
          timestamp: msg.timestamp,
        })
      : toolResultEvent({ id, catId: msg.catId, content: msg.content, timestamp: msg.timestamp });
  const target = namedTarget(msg, msg.threadId);
  if (target) {
    writeToolEvent(target, event, writerStore(options));
    touchStreamActivity(options.store, msg.threadId, target.messageId);
  } else {
    dropUnnamedBodyWrite(msg.type, msg, msg.threadId);
  }
  options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
}

function handleSystemInfo(msg: BackgroundAgentMessage, options: Options): void {
  if (!msg.content) return;
  const result = consumeBackgroundSystemInfo(msg, options);
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
      ? ownSystemRowId(msg.messageId, options.store.getThreadState(msg.threadId).messages)
      : undefined;
  options.store.addMessageToThread(msg.threadId, {
    id: ownId ?? `bg-sys-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
    type: 'system',
    variant: result.variant,
    catId: msg.catId,
    content: result.content,
    timestamp: msg.timestamp,
    ...(extra ? { extra } : {}),
  });
}
