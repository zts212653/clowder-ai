import {
  type MessageOutputBoundaryRun,
  type MessageOutputLayoutV1,
  type ProcessTalkMode,
  readMessageOutputLayout,
} from '@cat-cafe/shared';
import type { ChatMessage, ToolEvent } from '@/stores/chat-types';

export interface ReplyOutputText {
  kind: 'text';
  id: string;
  text: string;
  start: number;
  end: number;
  /** Exact source slice crossing Markdown syntax; render it literally. */
  literal?: boolean;
}
export interface ReplyOutputTool {
  kind: 'tool';
  id: string;
}
export interface ReplyOutputProjection {
  answers: ReplyOutputText[];
  record: (ReplyOutputText | ReplyOutputTool)[];
  processCount: number;
  showEarlierText?: boolean;
}

function textRun(content: string, run: MessageOutputBoundaryRun): ReplyOutputText | undefined {
  const start = run.start + run.gluePrefixLength;
  if (content.slice(run.start, start) !== '\n'.repeat(run.gluePrefixLength)) return undefined;
  return { kind: 'text', id: run.id, text: content.slice(start, run.end), start, end: run.end };
}

function validTools(message: ChatMessage, refs: readonly { toolEventId: string; executionRef: string }[]): boolean {
  const tools = message.toolEvents ?? [];
  const byId = new Map<string, ToolEvent>(tools.map((tool) => [tool.id, tool]));
  if (byId.size !== tools.length || refs.length !== tools.length) return false;
  const visible =
    message.lifecycle?.kind === 'response'
      ? message.lifecycle.invocationId
      : (message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId);
  const executions = new Set([
    visible,
    ...(message.extra?.auxiliaryTurnExecutions ?? []).map((event) => event.invocationId),
  ]);
  return refs.every((ref) => {
    const tool = byId.get(ref.toolEventId);
    return tool?.executionRef === ref.executionRef && executions.has(ref.executionRef);
  });
}

/**
 * Every condition except the content digest. Checked before hashing, so a layout that cannot apply
 * (an incomplete stream's unavailable layout, a changed length, another owner, a missing tool, runs
 * that do not fit the body) never costs a digest.
 */
export function replyLayoutAwaitsDigest(
  message: ChatMessage,
  threadId: string,
  processTalk: ProcessTalkMode = 'whole',
): boolean {
  return unverifiedProjection(message, threadId, processTalk) !== undefined;
}

/** The complete projection, before the body digest is compared. */
function unverifiedProjection(message: ChatMessage, threadId: string, processTalk: ProcessTalkMode) {
  const layout = eligibleLayout(message, threadId, processTalk);
  if (!layout) return undefined;
  const tools = layout.order.filter((ref) => ref.kind === 'tool');
  if (!validTools(message, tools)) return undefined;
  const runs = projectedRuns(message.content, layout.runs);
  if (!runs) return undefined;
  const projection = composeOutputOrder(layout, runs);
  const output = projection ? appendHostTail(message.content, layout, projection) : undefined;
  return output ? { sha256: layout.contentRevision.sha256, output } : undefined;
}

function eligibleLayout(message: ChatMessage, threadId: string, processTalk: ProcessTalkMode) {
  const layout = readMessageOutputLayout(message.extra?.outputLayout);
  if (
    message.type !== 'assistant' ||
    message.origin !== 'stream' ||
    message.extra?.isExplicitPost ||
    message.contentBlocks?.length ||
    layout?.status !== 'available'
  )
    return undefined;
  if (
    layout.basis === 'successful_turn_last_tool' &&
    (processTalk !== 'record' ||
      message.isStreaming ||
      (message.lifecycle?.kind === 'response' && message.lifecycle.status !== 'completed'))
  )
    return undefined;
  if (
    layout.owner.threadId !== threadId ||
    layout.owner.catId !== message.catId ||
    layout.owner.turnInvocationId !==
      (message.lifecycle?.kind === 'response'
        ? message.lifecycle.invocationId
        : (message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId)) ||
    layout.contentRevision.length !== message.content.length
  )
    return undefined;
  return layout;
}

function projectedRuns(content: string, input: readonly MessageOutputBoundaryRun[]) {
  const runs = new Map<string, ReplyOutputText>();
  for (const run of input) {
    const text = textRun(content, run);
    if (!text) return undefined;
    runs.set(run.id, text);
  }
  return runs;
}

function composeOutputOrder(
  layout: Extract<MessageOutputLayoutV1, { status: 'available' }>,
  runs: Map<string, ReplyOutputText>,
): ReplyOutputProjection | undefined {
  const answerIds = new Set(layout.runs.filter((run) => run.channel === 'final').map((run) => run.id));
  const answers: ReplyOutputText[] = [];
  const record: ReplyOutputProjection['record'] = [];
  for (const ref of layout.order) {
    if (ref.kind === 'tool') record.push({ kind: 'tool', id: ref.toolEventId });
    else {
      const text = runs.get(ref.runId);
      if (!text) return undefined;
      if (answerIds.has(text.id)) answers.push(text);
      else if (text.text.trim()) record.push(text);
    }
  }
  return {
    answers,
    record,
    processCount: record.filter((entry) => entry.kind === 'text').length,
    ...(layout.basis === 'successful_turn_last_tool' ? { showEarlierText: true } : {}),
  };
}

function appendHostTail(
  content: string,
  layout: Extract<MessageOutputLayoutV1, { status: 'available' }>,
  projection: ReplyOutputProjection,
): ReplyOutputProjection | undefined {
  const tail = layout.hostTail;
  if (!tail) return projection;
  const start = tail.start + tail.gluePrefixLength;
  if (content.slice(tail.start, start) !== '\n\n') return undefined;
  const id = `host-tail:${tail.start}:${tail.end}`;
  if (layout.runs.some((run) => run.id === id)) return undefined;
  return {
    ...projection,
    answers: [...projection.answers, { kind: 'text', id, text: content.slice(start, tail.end), start, end: tail.end }],
  };
}

/** Whole-message proof before any word moves out of the original body. */
export function projectReplyOutput(
  message: ChatMessage,
  threadId: string,
  verifiedHash?: string,
  processTalk: ProcessTalkMode = 'whole',
): ReplyOutputProjection | undefined {
  const candidate = unverifiedProjection(message, threadId, processTalk);
  if (!candidate || verifiedHash === undefined || candidate.sha256 !== verifiedHash) return undefined;
  return candidate.output;
}
