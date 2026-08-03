export interface CodexCapacityRecoveryAnchor {
  threadId: string;
  invocationId: string;
  promptMessageIds: readonly string[];
}

export type CodexCapacityPlanStatus = 'pending' | 'inProgress' | 'completed';

export interface CodexCapacityPlanItem {
  step: string;
  status: CodexCapacityPlanStatus;
}

export interface CodexCapacityPlanSnapshot {
  explanation?: string;
  plan: CodexCapacityPlanItem[];
}

export interface CodexCapacityToolSnapshot {
  id: string;
  type: string;
  label: string;
  status: 'in_flight' | 'terminal';
}

export interface CodexCapacityRecoveryCheckpointSnapshot {
  anchor?: {
    threadId: string;
    invocationId: string;
    promptMessageIds: string[];
  };
  nativeThreadId?: string;
  latestPlan?: CodexCapacityPlanSnapshot;
  tools: CodexCapacityToolSnapshot[];
  lastAgentMessage?: string;
}

export type CodexCapacityRecoveryBlockReason = 'blocked_inflight_tool' | 'checkpoint_incomplete' | 'budget_exhausted';

const MAX_PROMPT_MESSAGE_IDS = 24;
const MAX_PLAN_ITEMS = 16;
const MAX_STEP_CHARS = 320;
const MAX_EXPLANATION_CHARS = 640;
const MAX_AGENT_MESSAGE_CHARS = 800;
const MAX_TOOL_LABEL_CHARS = 240;

const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'dynamic_tool_call']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().split(/\s+/u).join(' ');
  if (!text) return undefined;
  return text.slice(0, maxChars);
}

function normalizePlanStatus(value: unknown): CodexCapacityPlanStatus | null {
  if (value === 'completed') return 'completed';
  if (value === 'inProgress' || value === 'in_progress') return 'inProgress';
  if (value === 'pending') return 'pending';
  return null;
}

function normalizeAnchor(anchor: CodexCapacityRecoveryAnchor | undefined): CodexCapacityRecoveryAnchor | undefined {
  if (!anchor) return undefined;
  const threadId = boundedText(anchor.threadId, 160);
  const invocationId = boundedText(anchor.invocationId, 160);
  if (!threadId || !invocationId) return undefined;
  const promptMessageIds = [
    ...new Set(
      anchor.promptMessageIds
        .map((messageId) => boundedText(messageId, 160))
        .filter((messageId): messageId is string => Boolean(messageId)),
    ),
  ].slice(0, MAX_PROMPT_MESSAGE_IDS);
  return { threadId, invocationId, promptMessageIds };
}

function normalizePlan(value: unknown): CodexCapacityPlanSnapshot | undefined {
  const event = asRecord(value);
  if (event?.type !== 'turn.plan.updated') return undefined;
  const plan = Array.isArray(event.plan)
    ? event.plan
        .slice(0, MAX_PLAN_ITEMS)
        .map((itemValue) => {
          const item = asRecord(itemValue);
          const step = boundedText(item?.step, MAX_STEP_CHARS);
          const status = normalizePlanStatus(item?.status);
          return step && status ? { step, status } : null;
        })
        .filter((item): item is CodexCapacityPlanItem => item !== null)
    : [];
  if (plan.length === 0) return undefined;
  const explanation = boundedText(event.explanation, MAX_EXPLANATION_CHARS);
  return { ...(explanation ? { explanation } : {}), plan };
}

function toolLabel(item: Record<string, unknown>): string {
  if (item.type === 'command_execution') {
    return boundedText(item.command, MAX_TOOL_LABEL_CHARS) ?? 'command execution';
  }
  if (item.type === 'mcp_tool_call') {
    const server = boundedText(item.server, 80) ?? 'unknown';
    const tool = boundedText(item.tool, 120) ?? 'unknown';
    return `${server}/${tool}`.slice(0, MAX_TOOL_LABEL_CHARS);
  }
  if (item.type === 'dynamic_tool_call') {
    return boundedText(item.tool, MAX_TOOL_LABEL_CHARS) ?? 'dynamic tool call';
  }
  return 'file change';
}

export class CodexCapacityRecoveryCheckpoint {
  private readonly anchor: CodexCapacityRecoveryAnchor | undefined;
  private nativeThreadId: string | undefined;
  private latestPlan: CodexCapacityPlanSnapshot | undefined;
  private readonly tools = new Map<string, CodexCapacityToolSnapshot>();
  private lastAgentMessage: string | undefined;
  private anonymousToolSequence = 0;

  constructor(anchor?: CodexCapacityRecoveryAnchor) {
    this.anchor = normalizeAnchor(anchor);
  }

  setNativeThreadId(threadId: string | undefined): void {
    const normalized = boundedText(threadId, 160);
    if (normalized) this.nativeThreadId = normalized;
  }

  observe(value: unknown): void {
    const plan = normalizePlan(value);
    if (plan) {
      this.latestPlan = plan;
      return;
    }

    const event = asRecord(value);
    if (event?.type !== 'item.started' && event?.type !== 'item.completed') return;
    const item = asRecord(event.item);
    if (!item || typeof item.type !== 'string') return;

    if (event.type === 'item.completed' && item.type === 'agent_message') {
      this.lastAgentMessage = boundedText(item.text, MAX_AGENT_MESSAGE_CHARS);
      return;
    }
    if (!TOOL_ITEM_TYPES.has(item.type)) return;

    const itemId =
      boundedText(item.id, 160) ??
      (event.type === 'item.started'
        ? `unidentified-tool-${++this.anonymousToolSequence}`
        : `unmatched-terminal-${++this.anonymousToolSequence}`);
    this.tools.set(itemId, {
      id: itemId,
      type: item.type,
      label: toolLabel(item),
      status: event.type === 'item.completed' ? 'terminal' : 'in_flight',
    });
  }

  hasObservedTools(): boolean {
    return this.tools.size > 0;
  }

  hasExactAnchor(): boolean {
    return Boolean(this.anchor && this.anchor.promptMessageIds.length > 0);
  }

  hasInFlightTool(): boolean {
    return [...this.tools.values()].some((tool) => tool.status === 'in_flight');
  }

  canResumeAfterTools(): boolean {
    return Boolean(this.hasExactAnchor() && this.latestPlan && !this.hasInFlightTool() && this.hasObservedTools());
  }

  nextIncompleteStep(): CodexCapacityPlanItem | undefined {
    return (
      this.latestPlan?.plan.find((item) => item.status === 'inProgress') ??
      this.latestPlan?.plan.find((item) => item.status === 'pending')
    );
  }

  snapshot(): CodexCapacityRecoveryCheckpointSnapshot {
    return {
      ...(this.anchor
        ? {
            anchor: {
              threadId: this.anchor.threadId,
              invocationId: this.anchor.invocationId,
              promptMessageIds: [...this.anchor.promptMessageIds],
            },
          }
        : {}),
      ...(this.nativeThreadId ? { nativeThreadId: this.nativeThreadId } : {}),
      ...(this.latestPlan
        ? {
            latestPlan: {
              ...(this.latestPlan.explanation ? { explanation: this.latestPlan.explanation } : {}),
              plan: this.latestPlan.plan.map((item) => ({ ...item })),
            },
          }
        : {}),
      tools: [...this.tools.values()].map((tool) => ({ ...tool })),
      ...(this.lastAgentMessage ? { lastAgentMessage: this.lastAgentMessage } : {}),
    };
  }
}
