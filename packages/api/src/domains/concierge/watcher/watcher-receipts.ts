import { parseWatcherThreadControl, type WatcherThreadControl } from '@cat-cafe/shared';
import { z } from 'zod';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import type { SuggestionService } from '../../suggestions/SuggestionService.js';
import type { SuggestionActionHandler, SuggestionActionRegistry } from '../../suggestions/suggestion-actions.js';

interface Owners {
  threads: IThreadStore;
  executions: ITurnExecutionStore;
  messages: IMessageStore;
  registry: SuggestionActionRegistry;
  service: SuggestionService;
  changed(threadId: string): void;
}
const undoRef = z
  .object({
    threadId: z.string().min(1),
    appliedRevision: z.number().int().nonnegative(),
    previous: z
      .object({ enabled: z.boolean().optional(), pausedUntil: z.number().int().nonnegative().optional() })
      .strict(),
  })
  .strict();

/** The original suggestion owner stores the row and runs the person's undo. This adapter owns only watcher controls. */
export function createWatcherReceipts(owners: Owners) {
  for (const kind of ['watcher_pause', 'watcher_close', 'watcher_open'] as const) {
    const handler: SuggestionActionHandler = {
      kind,
      kindLabel: kind === 'watcher_pause' ? '暂停守望猫' : kind === 'watcher_open' ? '开启守望猫' : '关闭守望猫',
      undoLabel: kind === 'watcher_pause' ? 'resume' : 'undo',
      prepare: async () => ({ ok: false, error: '请直接在对话里告诉守望猫' }),
      apply: async () => ({ ok: false, error: '此动作只承接已生效的对话指令' }),
      async undo(ctx, raw) {
        const parsed = undoRef.safeParse(raw);
        if (!parsed.success || parsed.data.threadId !== ctx.threadId) return { ok: false, error: '回执归属不符' };
        const thread = await owners.threads.get(ctx.threadId);
        if (!thread || thread.deletedAt || thread.createdBy !== ctx.userId) return { ok: false, error: '对话不存在' };
        const current = parseWatcherThreadControl(thread.watcher);
        if (current.undoOf === ctx.suggestionId) return { ok: true, value: undefined };
        if (current.revision !== parsed.data.appliedRevision)
          return { ok: false, error: '守望设置已改变，请使用当前对话设置' };
        const previous = parsed.data.previous;
        const next = await owners.threads.updateWatcherControl(
          ctx.threadId,
          current.revision,
          {
            enabled: previous.enabled ?? null,
            pausedUntil: previous.pausedUntil ?? null,
          },
          {
            undoOf: ctx.suggestionId,
            ...(kind === 'watcher_close'
              ? { startedAfterSequence: await owners.executions.settledHead(ctx.userId, ctx.threadId) }
              : {}),
          },
        );
        if (!next) return { ok: false, error: '守望设置已改变，请重试' };
        owners.changed(ctx.threadId);
        return { ok: true, value: undefined };
      },
    };
    owners.registry.register(handler);
  }
  return {
    async control(input: {
      userId: string;
      threadId: string;
      catId: string;
      messageId: string;
      previous: WatcherThreadControl;
      current: WatcherThreadControl;
      operation: 'open' | 'close' | 'pause';
    }) {
      const closed = input.operation === 'close';
      const opened = input.operation === 'open';
      const time =
        input.current.pausedUntil === undefined
          ? ''
          : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(
              input.current.pausedUntil,
            );
      return owners.service.recordReceipt({
        actor: { userId: input.userId, threadId: input.threadId, catId: input.catId, byline: 'watcher' },
        messageId: input.messageId,
        text: closed ? '已关闭' : opened ? '已开启' : `已暂停至 ${time}`,
        action: {
          kind: closed ? 'watcher_close' : opened ? 'watcher_open' : 'watcher_pause',
          appliedRef: {
            threadId: input.threadId,
            appliedRevision: input.current.revision,
            previous: {
              ...(input.previous.enabled === undefined ? {} : { enabled: input.previous.enabled }),
              ...(input.previous.pausedUntil === undefined ? {} : { pausedUntil: input.previous.pausedUntil }),
            },
          },
        },
      });
    },
    async nudge(input: {
      userId: string;
      threadId: string;
      catId: string;
      sourceInvocationId: string;
      targetName: string;
    }) {
      const source = await owners.executions.get(input.sourceInvocationId);
      if (source?.responseSettlement?.kind !== 'message') return;
      const message = await owners.messages.getById(source.responseSettlement.messageId);
      if (!message?.mentionsUser) return;
      return owners.service.recordReceipt({
        actor: { userId: input.userId, threadId: input.threadId, catId: input.catId, byline: 'watcher' },
        messageId: message.id,
        text: `已向${input.targetName}补了一句`,
        mergeWatcherSupplement: true,
      });
    },
  };
}
