import type { LifecycleDispatchRef } from '@cat-cafe/shared';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';

export interface SingleCatConversationInput {
  message: ChatMessage;
  evidence: 'read' | 'unconfirmed';
  readAt?: number;
  source: 'response' | 'whisper' | 'queue';
}

export type SingleCatConversationBlock =
  | {
      kind: 'execution';
      key: string;
      startedAt: number;
      invocationId: string;
      response: ChatMessage;
      readInputs: SingleCatConversationInput[];
      unconfirmedInputs: SingleCatConversationInput[];
    }
  | { kind: 'standalone-output'; key: string; message: ChatMessage }
  | { kind: 'pending-inputs'; key: string; inputs: SingleCatConversationInput[] };

export interface SingleCatConversationProjection {
  blocks: SingleCatConversationBlock[];
  hasEvidence: boolean;
}

type ResponseLifecycle = Extract<NonNullable<ChatMessage['lifecycle']>, { kind: 'response' }>;
type IndexedInput = SingleCatConversationInput & { admissionIndex: number; sourceIndex: number };

interface ExecutionSeed {
  response: ChatMessage;
  lifecycle: ResponseLifecycle;
  sourceIndex: number;
  readInputs: IndexedInput[];
  unconfirmedInputs: IndexedInput[];
}

interface InputAssociation {
  execution: ExecutionSeed;
  exactRef?: LifecycleDispatchRef;
  privateReverseLink: boolean;
  admissionIndex: number;
}

function senderCatId(message: ChatMessage): string | undefined {
  if (message.from?.kind === 'agent') return message.from.catId;
  return message.type === 'assistant' ? message.catId : undefined;
}

function isSelectedExecution(
  message: ChatMessage,
  catId: string,
): message is ChatMessage & { lifecycle: ResponseLifecycle } {
  return (
    message.lifecycle?.kind === 'response' && message.lifecycle.targetId === catId && senderCatId(message) === catId
  );
}

function uniqueMessagesById(messages: readonly ChatMessage[]): Map<string, ChatMessage> {
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message.id, (counts.get(message.id) ?? 0) + 1);
  return new Map(messages.filter((message) => counts.get(message.id) === 1).map((message) => [message.id, message]));
}

function collectExecutions(
  messages: readonly ChatMessage[],
  uniqueMessages: ReadonlyMap<string, ChatMessage>,
  catId: string,
): ExecutionSeed[] {
  const executions: ExecutionSeed[] = [];
  messages.forEach((message, sourceIndex) => {
    if (uniqueMessages.get(message.id) !== message || !isSelectedExecution(message, catId)) return;
    executions.push({
      response: message,
      lifecycle: message.lifecycle,
      sourceIndex,
      readInputs: [],
      unconfirmedInputs: [],
    });
  });
  return executions;
}

function resolveInputAssociation(input: {
  messageId: string;
  message: ChatMessage;
  catId: string;
  executions: readonly ExecutionSeed[];
  executionByResponseId: ReadonlyMap<string, ExecutionSeed>;
}): InputAssociation | undefined {
  const { messageId, message, catId, executions, executionByResponseId } = input;
  const publicExecutions = executions.filter((execution) => execution.lifecycle.inputMessageIds.includes(messageId));
  const targetRefs = message.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === catId) ?? [];
  const exactRef = targetRefs.length === 1 ? targetRefs[0] : undefined;
  const exactExecution = exactRef ? executionByResponseId.get(exactRef.statusMessageId) : undefined;
  const admissionIndex = exactExecution?.lifecycle.inputMessageIds.indexOf(messageId) ?? -1;
  const privateReverseLink =
    message.visibility === 'whisper' && message.whisperTo?.includes(catId) === true && exactExecution !== undefined;

  if (exactRef) {
    if (!exactExecution || (admissionIndex < 0 && !privateReverseLink)) return;
    return { execution: exactExecution, exactRef, privateReverseLink, admissionIndex };
  }
  if (publicExecutions.length !== 1) return;
  const execution = publicExecutions[0];
  if (!execution) return;
  return {
    execution,
    privateReverseLink: false,
    admissionIndex: execution.lifecycle.inputMessageIds.indexOf(messageId),
  };
}

function confirmedReadAt(association: InputAssociation): number | undefined {
  if (association.exactRef?.statusMessageId !== association.execution.response.id) return;
  return association.exactRef.inputRead?.status === 'read' ? association.exactRef.inputRead.at : undefined;
}

function projectAssociatedInput(
  message: ChatMessage,
  association: InputAssociation,
  sourceIndex: number,
): IndexedInput {
  const readAt = confirmedReadAt(association);
  return {
    message,
    evidence: readAt === undefined ? 'unconfirmed' : 'read',
    ...(readAt === undefined ? {} : { readAt }),
    source: association.privateReverseLink && association.admissionIndex < 0 ? 'whisper' : 'response',
    admissionIndex: association.admissionIndex < 0 ? Number.MAX_SAFE_INTEGER : association.admissionIndex,
    sourceIndex,
  };
}

function assignInputs(input: {
  uniqueMessages: ReadonlyMap<string, ChatMessage>;
  sourceIndexById: ReadonlyMap<string, number>;
  catId: string;
  executions: readonly ExecutionSeed[];
  executionByResponseId: ReadonlyMap<string, ExecutionSeed>;
  selectedResponseIds: ReadonlySet<string>;
}): Set<string> {
  const assignedInputIds = new Set<string>();
  for (const [messageId, message] of input.uniqueMessages) {
    if (input.selectedResponseIds.has(messageId)) continue;
    const association = resolveInputAssociation({ ...input, messageId, message });
    if (!association) continue;
    const projected = projectAssociatedInput(
      message,
      association,
      input.sourceIndexById.get(messageId) ?? Number.MAX_SAFE_INTEGER,
    );
    const target =
      projected.evidence === 'read' ? association.execution.readInputs : association.execution.unconfirmedInputs;
    target.push(projected);
    assignedInputIds.add(messageId);
  }
  return assignedInputIds;
}

function sortExecutionInputs(executions: readonly ExecutionSeed[]): void {
  for (const execution of executions) {
    execution.readInputs.sort(
      (left, right) =>
        (left.readAt ?? Number.MAX_SAFE_INTEGER) - (right.readAt ?? Number.MAX_SAFE_INTEGER) ||
        left.admissionIndex - right.admissionIndex ||
        left.sourceIndex - right.sourceIndex,
    );
    execution.unconfirmedInputs.sort(
      (left, right) => left.admissionIndex - right.admissionIndex || left.sourceIndex - right.sourceIndex,
    );
  }
}

function withoutProjectionIndexes(input: IndexedInput): SingleCatConversationInput {
  const projected: SingleCatConversationInput = {
    message: input.message,
    evidence: input.evidence,
    source: input.source,
  };
  if ('readAt' in input) projected.readAt = input.readAt;
  return projected;
}

function executionBlock(execution: ExecutionSeed, catId: string): SingleCatConversationBlock {
  return {
    kind: 'execution',
    key: `execution:${catId}:${execution.lifecycle.invocationId}:${execution.response.id}`,
    startedAt: execution.lifecycle.startedAt,
    invocationId: execution.lifecycle.invocationId,
    response: execution.response,
    readInputs: execution.readInputs.map(withoutProjectionIndexes),
    unconfirmedInputs: execution.unconfirmedInputs.map(withoutProjectionIndexes),
  };
}

function collectOrderedBlocks(input: {
  messages: readonly ChatMessage[];
  uniqueMessages: ReadonlyMap<string, ChatMessage>;
  catId: string;
  executions: readonly ExecutionSeed[];
  selectedResponseIds: ReadonlySet<string>;
  assignedInputIds: ReadonlySet<string>;
}): SingleCatConversationBlock[] {
  const ordered: Array<{ at: number; sourceIndex: number; block: SingleCatConversationBlock }> = input.executions.map(
    (execution) => ({
      at: execution.lifecycle.startedAt,
      sourceIndex: execution.sourceIndex,
      block: executionBlock(execution, input.catId),
    }),
  );
  input.messages.forEach((message, sourceIndex) => {
    if (input.uniqueMessages.get(message.id) !== message) return;
    if (senderCatId(message) !== input.catId) return;
    if (message.lifecycle?.kind === 'response') return;
    if (input.selectedResponseIds.has(message.id) || input.assignedInputIds.has(message.id)) return;
    ordered.push({
      at: getMessageTimelineOrderTime(message),
      sourceIndex,
      block: { kind: 'standalone-output', key: `output:${message.id}`, message },
    });
  });
  ordered.sort((left, right) => left.at - right.at || left.sourceIndex - right.sourceIndex);
  return ordered.map((item) => item.block);
}

function pendingMessageIds(entry: QueueEntry): string[] {
  return [entry.messageId, ...entry.mergedMessageIds].filter((messageId): messageId is string => Boolean(messageId));
}

function collectPendingInputs(input: {
  queuedForCat: readonly QueueEntry[];
  uniqueMessages: ReadonlyMap<string, ChatMessage>;
  assignedInputIds: ReadonlySet<string>;
  selectedResponseIds: ReadonlySet<string>;
  catId: string;
}): SingleCatConversationInput[] {
  const pendingIds = new Set<string>();
  const pendingInputs: SingleCatConversationInput[] = [];
  for (const entry of input.queuedForCat) {
    for (const messageId of pendingMessageIds(entry)) {
      if (pendingIds.has(messageId) || input.assignedInputIds.has(messageId)) continue;
      if (input.selectedResponseIds.has(messageId)) continue;
      const message = input.uniqueMessages.get(messageId);
      if (!message || message.lifecycle?.dispatchRefs?.some((ref) => ref.targetId === input.catId)) continue;
      pendingIds.add(messageId);
      pendingInputs.push({ message, evidence: 'unconfirmed', source: 'queue' });
    }
  }
  pendingInputs.sort(
    (left, right) =>
      getMessageTimelineOrderTime(left.message) - getMessageTimelineOrderTime(right.message) ||
      left.message.id.localeCompare(right.message.id),
  );
  return pendingInputs;
}

export function projectSingleCatConversation(input: {
  messages: readonly ChatMessage[];
  queue: readonly QueueEntry[];
  catId: string;
}): SingleCatConversationProjection {
  const uniqueMessages = uniqueMessagesById(input.messages);
  const sourceIndexById = new Map(input.messages.map((message, index) => [message.id, index]));
  const executions = collectExecutions(input.messages, uniqueMessages, input.catId);
  const executionByResponseId = new Map(executions.map((execution) => [execution.response.id, execution]));
  const selectedResponseIds = new Set(executionByResponseId.keys());
  const assignedInputIds = assignInputs({
    uniqueMessages,
    sourceIndexById,
    catId: input.catId,
    executions,
    executionByResponseId,
    selectedResponseIds,
  });
  sortExecutionInputs(executions);
  const blocks = collectOrderedBlocks({ ...input, uniqueMessages, executions, selectedResponseIds, assignedInputIds });
  const queuedForCat = input.queue.filter((entry) => entry.targetCats.includes(input.catId));
  const pendingInputs = collectPendingInputs({
    queuedForCat,
    uniqueMessages,
    assignedInputIds,
    selectedResponseIds,
    catId: input.catId,
  });
  if (pendingInputs.length > 0) {
    blocks.push({ kind: 'pending-inputs', key: `pending:${input.catId}`, inputs: pendingInputs });
  }
  return { blocks, hasEvidence: blocks.length > 0 };
}
