import type { CatId, ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';
import type { CodexSubexecutionEvent } from '../../cats/services/agents/providers/CodexSubexecutionIdentity.js';
import { transformCodexEvent } from '../../cats/services/agents/providers/codex-event-transform.js';
import type {
  AppendMessageInput,
  IMessageStore,
  StoredMessage,
} from '../../cats/services/stores/ports/MessageStore.js';

interface Child {
  identity: ProviderSubexecutionSemanticEvent;
  startedAt: number;
  terminal: boolean;
  sourceRefs: readonly string[];
  turnId?: string;
  resultRef?: string;
}

/** A projection into the existing durable Message history; it grants no child tool credentials. */
export class LiveSubexecutionLog {
  private closed = false;
  private readonly rootTurns = new Set<string>();
  private readonly children = new Map<string, Child>();
  private readonly seen = new Set<string>();
  private readonly sources = new Map<string, Set<string>>();
  private queue = Promise.resolve();
  constructor(
    private readonly deps: {
      scope: { userId: string; threadId: string; catId: CatId; callId: string };
      rootThread(): string | undefined;
      available(): boolean;
      verify(): Promise<boolean>;
      store: Pick<IMessageStore, 'appendIdempotent'>;
      publish(message: StoredMessage): void;
      recorded?(event: ProviderSubexecutionSemanticEvent, message: StoredMessage): void;
    },
  ) {}

  rootStarted(threadId: string, turnId: string): void {
    if (this.closed || threadId !== this.deps.rootThread()) return;
    if (this.rootTurns.size < 256) this.rootTurns.add(turnId);
  }

  /** Only the Host's acknowledged input port calls this; model-supplied references cannot bind identity. */
  acceptedInput(turnId: string, refs: readonly string[]): void {
    if (this.closed || (!this.sources.has(turnId) && this.sources.size >= 256)) return;
    const sources = this.sources.get(turnId) ?? new Set<string>();
    for (const ref of refs) {
      if (sources.size >= 32) break;
      if (!ref || ref.length > 512 || /[\u0000-\u001f\u007f]/.test(ref)) continue;
      sources.add(
        ref.startsWith('task:') || ref.startsWith('thread:')
          ? ref
          : `thread:${ref.includes('#') ? ref : `${this.deps.scope.threadId}#${ref}`}`,
      );
    }
    this.sources.set(turnId, sources);
  }

  observe(event: CodexSubexecutionEvent): Promise<void> {
    const operation = this.queue.then(() => this.record(event));
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async record(event: CodexSubexecutionEvent): Promise<void> {
    if (
      !this.available() ||
      event.root_execution_id !== this.deps.rootThread() ||
      event.subexecution_id === event.root_execution_id ||
      !this.rootTurns.has(event.root_turn_id)
    )
      return;
    const message = transformCodexEvent(event, this.deps.scope.catId);
    const semantic = message && !Array.isArray(message) ? message.semanticEvent : undefined;
    if (semantic?.kind !== 'subexecution' || this.seen.has(semantic.id) || this.seen.size >= 4096) return;
    const child = this.admit(semantic);
    if (!child) return;
    if (!(await this.deps.verify()) || !this.available()) return;
    const terminal = ['completed', 'failed', 'interrupted'].includes(semantic.stage);
    const result = await this.append({
      userId: this.deps.scope.userId,
      threadId: this.deps.scope.threadId,
      from: { kind: 'agent', catId: this.deps.scope.catId },
      content: describe(child, semantic, terminal, child.sourceRefs),
      timestamp: semantic.occurredAt,
      mentions: [],
      origin: 'stream',
      idempotencyKey: `live-subexecution:${this.deps.scope.callId}:${semantic.id}`,
      metadata: { provider: 'codex', model: 'unknown', subexecutionEvents: [semantic] },
      // This standalone usage ledger is a visible Message, not F306's suppressed
      // raw event carrier. Keep the canonical event in existing child metadata.
    });
    // A committed fact remains history after stop; it cannot start a new live publication.
    if (!this.available()) return;
    this.seen.add(semantic.id);
    this.children.set(semantic.subexecutionId, child);
    if (semantic.stage === 'message' && semantic.messagePhase === 'final_answer')
      child.resultRef = `thread:${this.deps.scope.threadId}#${result.message.id}`;
    if (terminal) child.terminal = true;
    if (!result.idempotent) this.deps.publish(result.message);
    if (!result.idempotent) this.deps.recorded?.(semantic, result.message);
  }

  /** Recording is required for the enabled child lane; do not continue with untraceable use or expose storage diagnostics. */
  private async append(input: AppendMessageInput) {
    try {
      return await this.deps.store.appendIdempotent(input);
    } catch {
      throw new Error('Live native child usage history unavailable');
    }
  }

  private admit(semantic: ProviderSubexecutionSemanticEvent): Child | undefined {
    const child = this.children.get(semantic.subexecutionId);
    if (semantic.stage === 'started') {
      if (child) {
        if (
          !sameChild(child.identity, semantic) ||
          !semantic.turnId ||
          child.turnId === semantic.turnId ||
          (!child.terminal && child.turnId) ||
          semantic.occurredAt < child.startedAt
        )
          return;
        return {
          identity: child.identity,
          sourceRefs: child.sourceRefs,
          startedAt: semantic.occurredAt,
          terminal: false,
          turnId: semantic.turnId,
        };
      }
      if (this.children.size >= 64) return;
      const parent = this.children.get(semantic.parentExecutionId);
      const rootParent = semantic.parentExecutionId === semantic.rootExecutionId;
      if (
        rootParent
          ? semantic.depth !== 1
          : !parent ||
            parent.identity.rootTurnId !== semantic.rootTurnId ||
            parent.terminal ||
            semantic.depth !== parent.identity.depth + 1
      )
        return;
      return {
        identity: semantic,
        sourceRefs: parent?.sourceRefs ?? [...(this.sources.get(semantic.rootTurnId) ?? [])],
        startedAt: semantic.occurredAt,
        terminal: false,
        turnId: semantic.turnId,
      };
    } else if (
      !child ||
      child.terminal ||
      (child.turnId && semantic.turnId !== child.turnId) ||
      !sameChild(child.identity, semantic) ||
      semantic.occurredAt < child.startedAt
    )
      return;
    return { ...child, turnId: child.turnId ?? semantic.turnId };
  }

  close(): void {
    this.closed = true;
    this.rootTurns.clear();
    this.children.clear();
    this.seen.clear();
    this.sources.clear();
  }
  private available(): boolean {
    return !this.closed && this.deps.available();
  }
}

function sameChild(a: ProviderSubexecutionSemanticEvent, b: ProviderSubexecutionSemanticEvent): boolean {
  return (
    a.rootExecutionId === b.rootExecutionId &&
    a.parentExecutionId === b.parentExecutionId &&
    a.rootTurnId === b.rootTurnId &&
    a.parentTurnId === b.parentTurnId &&
    a.agentPath === b.agentPath &&
    a.depth === b.depth
  );
}

function describe(
  child: Child,
  event: ProviderSubexecutionSemanticEvent,
  terminal: boolean,
  sources: readonly string[],
): string {
  return [
    `原生子执行 · ${event.nickname ?? event.agentPath} · ${event.stage}`,
    `父/子：${event.parentExecutionId} / ${event.subexecutionId}`,
    `原请求：native:${event.rootExecutionId}/${event.rootTurnId}；任务引用：未知（不得猜测 Task）`,
    `根线程已受理的原请求/上下文引用：${sources.join('、') || '未知（尚无原请求提交回执）'}`,
    `开始：${child.startedAt}；结束：${terminal ? event.occurredAt : '未知'}；耗时：${terminal ? `${event.occurredAt - child.startedAt}ms` : '未知'}`,
    `结果引用：${child.resultRef ?? '尚无已提交的 final 结果'}`,
    '工具范围：仅父提供的材料；家内工具不可用（认证只认根线程当前轮次），shell、文件写入、浏览器、屏幕与麦克风未开放。',
    ...(event.content ? [`子执行输出（不代表根任务完成）：\n${event.content}`] : []),
  ].join('\n');
}
