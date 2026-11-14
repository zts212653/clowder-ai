import type { SuggestionReceiptView, SuggestionUndoLabel } from '@cat-cafe/shared';

/**
 * F335 交付二：每一种提议就是一个动作。猫把动作拟好（params），人点一下才执行；回执上的撤销 / 恢复调同一个动作的 undo。
 *
 * 动作在服务端登记，猫不能塞任意 endpoint。线 1（守望猫醒来）的「已暂停至 02:10 · 恢复」「已关闭 · 撤销」也在这里登记
 * 自己的 undo，再用 `SuggestionService.recordReceipt` 挂回执，不另写一套。
 */
export interface SuggestionActionContext {
  userId: string;
  threadId: string;
  catId: string;
  suggestionId: string;
  /**
   * Which apply this is (1, 2 after an undo, …). An action that keys its writes by `suggestionId` + `attempt` replays a
   * retried attempt instead of doing it twice, and still writes afresh after an undo. Present on `apply` only.
   */
  attempt?: number;
}

export type SuggestionActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * An apply that fails after doing part of the work first tries to take that part back. If it cannot, it returns what
 * it did as `partial`, so the row tells the truth (「已添加 2 条批注（其余没加上）」) and can still be undone.
 */
export type SuggestionApplyResult =
  | { ok: true; value: SuggestionApplied }
  | { ok: false; error: string; partial?: SuggestionApplied };

export interface SuggestionApplied {
  /** What undo / inspect need later. Stays on the server. */
  appliedRef: Record<string, unknown>;
  receipt: SuggestionReceiptView;
}

/** Whether what was applied still looks the way the suggestion left it. */
export type SuggestionInspection = 'intact' | 'edited' | 'gone' | 'unknown';

export interface SuggestionActionHandler {
  kind: string;
  /** The kind's own name, used for 「已隐藏的建议」 rows (添加视频批注 / 创建定时任务). */
  kindLabel: string;
  /** How the applied row's undo control reads. */
  undoLabel: SuggestionUndoLabel;
  /** Validate the cat's prepared action when it is offered, so the person never taps something that cannot run. */
  prepare(
    ctx: SuggestionActionContext,
    params: Record<string, unknown>,
  ): Promise<SuggestionActionResult<Record<string, unknown>>>;
  apply(ctx: SuggestionActionContext, params: Record<string, unknown>): Promise<SuggestionApplyResult>;
  undo(ctx: SuggestionActionContext, appliedRef: Record<string, unknown>): Promise<SuggestionActionResult<void>>;
  /** 「改了」：read back what was applied. Optional; kinds without it never report edits. */
  inspect?(ctx: SuggestionActionContext, appliedRef: Record<string, unknown>): Promise<SuggestionInspection>;
  /**
   * A cat posting a receipt for something it already did must point at something in this user's scope; otherwise the
   * person's undo click could reach anything. Kinds without it cannot be used for cat-posted receipts.
   */
  verifyReceipt?(ctx: SuggestionActionContext, appliedRef: Record<string, unknown>): Promise<boolean>;
}

export class SuggestionActionRegistry {
  private readonly handlers = new Map<string, SuggestionActionHandler>();

  register(handler: SuggestionActionHandler): void {
    if (this.handlers.has(handler.kind)) throw new Error(`Suggestion kind already registered: ${handler.kind}`);
    this.handlers.set(handler.kind, handler);
  }

  get(kind: string): SuggestionActionHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }
}
