import { normalizeCatId, parseCommand } from '@cat-cafe/shared';
import type { CommandRegistry } from '../commands/CommandRegistry.js';
import type { IConnectorPermissionStore } from './ConnectorPermissionStore.js';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import {
  auditSlashCommand,
  buildCatsInfo,
  buildCommandsList,
  buildStatusInfo,
  buildThreadDeepLink,
  extractFeatIds,
  matchByFeatId,
  matchByIdPrefix,
  matchByListIndex,
  matchByTitle,
  resolveFeatBadges,
} from './connector-command-helpers.js';

export interface CommandResult {
  readonly kind:
    | 'new'
    | 'threads'
    | 'use'
    | 'where'
    | 'thread'
    | 'unbind'
    | 'allow-group'
    | 'deny-group'
    | 'commands'
    | 'cats'
    | 'status'
    | 'history'
    | 'focus'
    | 'ask'
    | 'not-command';
  readonly response?: string;
  readonly newActiveThreadId?: string;
  /** Thread context for storing command exchange in messageStore */
  readonly contextThreadId?: string;
  /** Message content to forward to target thread after switching (used by /thread, /ask) */
  readonly forwardContent?: string;
  /** F154: one-shot target cat for /ask routing */
  readonly targetCatId?: string;
}

interface ThreadEntry {
  id: string;
  title?: string | null;
  lastActiveAt?: number;
  backlogItemId?: string;
}

export interface ConnectorCommandLayerDeps {
  readonly bindingStore: IConnectorThreadBindingStore;
  readonly threadStore: {
    create(userId: string, title?: string): { id: string } | Promise<{ id: string }>;
    get(
      id: string,
    ):
      | { id: string; title?: string | null; createdAt?: number; preferredCats?: string[] }
      | null
      | Promise<{ id: string; title?: string | null; createdAt?: number; preferredCats?: string[] } | null>;
    /** List threads owned by userId (sorted by lastActiveAt desc). Phase C: cross-platform thread view */
    list(userId: string): ThreadEntry[] | Promise<ThreadEntry[]>;
    /** F154: Update thread preferred cats for /focus command */
    updatePreferredCats?(threadId: string, catIds: string[]): void | Promise<void>;
  };
  /** Phase D: optional backlog store for feat-number matching in /use */
  readonly backlogStore?: {
    get(
      itemId: string,
      userId?: string,
    ): { tags: readonly string[] } | null | Promise<{ tags: readonly string[] } | null>;
  };
  readonly frontendBaseUrl: string;
  readonly permissionStore?: IConnectorPermissionStore | undefined;
  /** F142: participant activity for /cats and /status */
  readonly participantStore?: {
    getParticipantsWithActivity(
      threadId: string,
    ):
      | Array<{ catId: string; lastMessageAt: number; messageCount: number }>
      | Promise<Array<{ catId: string; lastMessageAt: number; messageCount: number }>>;
  };
  /** F142: agent service registry for /cats */
  readonly agentRegistry?: { has(catId: string): boolean };
  /** F142: cat roster for display names + availability. Keys = catIds. */
  readonly catRoster?: Record<string, { displayName: string; available?: boolean }>;
  /** F142-B: unified command registry for /commands listing + skill detection + audit */
  readonly commandRegistry?: CommandRegistry;
  /** #687: message store for /history round-based retrieval (AC-8: cursor-based) */
  readonly messageStore?: {
    getByThreadBefore(
      threadId: string,
      timestamp: number,
      limit?: number,
    ):
      | Array<{ catId: string | null; userId?: string; content: string; timestamp: number; source?: string }>
      | Promise<Array<{ catId: string | null; userId?: string; content: string; timestamp: number; source?: string }>>;
  };
}

export class ConnectorCommandLayer {
  constructor(private readonly deps: ConnectorCommandLayerDeps) {}

  async handle(
    connectorId: string,
    externalChatId: string,
    userId: string,
    text: string,
    senderId?: string,
  ): Promise<CommandResult> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return { kind: 'not-command' };

    const t0 = Date.now();
    const result = await this.dispatch(connectorId, externalChatId, userId, trimmed, senderId);
    if (result.kind !== 'not-command') auditSlashCommand(trimmed, Date.now() - t0, this.deps.commandRegistry);
    return result;
  }

  private async dispatch(
    connectorId: string,
    externalChatId: string,
    userId: string,
    trimmed: string,
    senderId?: string,
  ): Promise<CommandResult> {
    // F142-B AC-B6: unified parser (longest-match, subcommand-aware)
    const registry = this.deps.commandRegistry;
    const parsed = registry ? parseCommand(trimmed, registry.getAll()) : null;
    const cmd = parsed?.name ?? trimmed.split(/\s+/)[0]?.toLowerCase();
    // F154 P1 fix: subcommand must be re-joined into args (parseCommand extracts it separately)
    const cmdArgs = parsed
      ? parsed.subcommand
        ? `${parsed.subcommand} ${parsed.args}`.trim()
        : parsed.args
      : trimmed.split(/\s+/).slice(1).join(' ');
    switch (cmd) {
      case '/where':
        return this.handleWhere(connectorId, externalChatId);
      case '/new':
        return this.handleNew(connectorId, externalChatId, userId, cmdArgs);
      case '/threads':
        return this.handleThreads(connectorId, externalChatId, userId);
      case '/use':
        return this.handleUse(connectorId, externalChatId, userId, cmdArgs);
      case '/thread':
        return this.handleThread(connectorId, externalChatId, userId, cmdArgs.split(/\s+/));
      case '/commands':
        return buildCommandsList(this.deps.commandRegistry);
      case '/cats':
        return this.handleCats(connectorId, externalChatId);
      case '/status':
        return this.handleStatus(connectorId, externalChatId);
      case '/history':
        return this.handleHistory(connectorId, externalChatId, userId, cmdArgs);
      case '/unbind':
        return this.handleUnbind(connectorId, externalChatId);
      case '/allow-group':
        return this.handleAllowGroup(connectorId, externalChatId, senderId, cmdArgs);
      case '/deny-group':
        return this.handleDenyGroup(connectorId, externalChatId, senderId, cmdArgs);
      case '/focus':
        return this.handleFocus(connectorId, externalChatId, userId, cmdArgs);
      case '/ask':
        return this.handleAsk(connectorId, externalChatId, userId, cmdArgs);
      default: // F142-B: unrecognized commands flow to cat (AC-B4)
        return { kind: 'not-command' };
    }
  }

  private async handleWhere(connectorId: string, externalChatId: string): Promise<CommandResult> {
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return {
        kind: 'where',
        response: '📍 当前没有绑定的 thread。发送任意消息会自动创建新 thread，或用 /new 手动创建。',
      };
    }
    const thread = await this.deps.threadStore.get(binding.threadId);
    const title = thread?.title ?? '(无标题)';
    const deepLink = buildThreadDeepLink(this.deps.frontendBaseUrl, binding.threadId);
    return {
      kind: 'where',
      contextThreadId: binding.threadId,
      response: `📍 当前 thread: ${title}\nID: ${binding.threadId}\n🔗 ${deepLink}`,
    };
  }

  private async handleNew(
    connectorId: string,
    externalChatId: string,
    userId: string,
    title?: string,
  ): Promise<CommandResult> {
    const effectiveTitle = title?.trim() ? title.trim() : undefined;
    const thread = await this.deps.threadStore.create(userId, effectiveTitle);
    await this.deps.bindingStore.bind(connectorId, externalChatId, thread.id, userId);
    const deepLink = buildThreadDeepLink(this.deps.frontendBaseUrl, thread.id);
    const titleDisplay = effectiveTitle ? ` "${effectiveTitle}"` : '';
    return {
      kind: 'new',
      newActiveThreadId: thread.id,
      contextThreadId: thread.id,
      response: `✨ 新 thread${titleDisplay} 已创建\nID: ${thread.id}\n🔗 ${deepLink}\n\n现在的消息会发到这个 thread。`,
    };
  }

  private async handleThreads(connectorId: string, externalChatId: string, userId: string): Promise<CommandResult> {
    const allThreads = await this.deps.threadStore.list(userId);
    const threads = allThreads.slice(0, 10);
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (threads.length === 0) {
      return { kind: 'threads', response: '📋 还没有 thread。发送消息或用 /new 创建一个吧！' };
    }
    const featBadges = await resolveFeatBadges(threads, userId, this.deps.backlogStore);
    const lines = threads.map((t, i) => {
      const title = t.title ?? '(无标题)';
      const badge = featBadges.get(t.id);
      return badge ? `${i + 1}. ${title} [${badge}] [${t.id}]` : `${i + 1}. ${title} [${t.id}]`;
    });
    const result: CommandResult = {
      kind: 'threads',
      response: `📋 最近的 threads:\n\n${lines.join('\n')}\n\n用 /use F088 或 /use 关键词 或 /use 3 切换`,
    };
    return binding ? { ...result, contextThreadId: binding.threadId } : result;
  }

  private async handleUse(
    connectorId: string,
    externalChatId: string,
    userId: string,
    input?: string,
  ): Promise<CommandResult> {
    if (!input) {
      return {
        kind: 'use',
        response: '❌ 用法: /use F088 | /use 关键词 | /use 3 | /use <ID前缀>\n用 /threads 查看可用列表。',
      };
    }
    const allThreads = await this.deps.threadStore.list(userId);
    const match =
      (await matchByFeatId(input, allThreads, userId, this.deps.backlogStore)) ??
      matchByListIndex(input, allThreads) ??
      matchByIdPrefix(input, allThreads) ??
      matchByTitle(input, allThreads);

    if (!match) {
      return { kind: 'use', response: `❌ 找不到匹配 "${input}" 的 thread。用 /threads 查看可用列表。` };
    }
    await this.deps.bindingStore.bind(connectorId, externalChatId, match.id, userId);
    const title = match.title ?? '(无标题)';
    const deepLink = buildThreadDeepLink(this.deps.frontendBaseUrl, match.id);
    return {
      kind: 'use',
      newActiveThreadId: match.id,
      contextThreadId: match.id,
      response: `🔄 已切换到: ${title}\nID: ${match.id}\n🔗 ${deepLink}`,
    };
  }

  private async handleThread(
    connectorId: string,
    externalChatId: string,
    userId: string,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        kind: 'thread',
        response: '❌ 用法: /thread <thread_id> <message>\n切换到指定 thread 并发送消息。',
      };
    }
    const [threadIdOrPrefix, ...msgParts] = args;
    const message = msgParts.join(' ');
    const allThreads = await this.deps.threadStore.list(userId);
    const match =
      allThreads.find((t) => t.id === threadIdOrPrefix) ?? allThreads.find((t) => t.id.startsWith(threadIdOrPrefix!));

    if (!match) {
      return { kind: 'thread', response: `❌ 找不到 thread "${threadIdOrPrefix}"。用 /threads 查看可用列表。` };
    }
    await this.deps.bindingStore.bind(connectorId, externalChatId, match.id, userId);
    const title = match.title ?? '(无标题)';
    return {
      kind: 'thread',
      newActiveThreadId: match.id,
      contextThreadId: match.id,
      forwardContent: message,
      response: `📨 → ${title} [${match.id}]`,
    };
  }

  private async handleCats(connectorId: string, externalChatId: string): Promise<CommandResult> {
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return { kind: 'cats', response: '⚠️ 当前没有绑定 thread，请先用 /new 创建或 /use 切换。' };
    }
    return buildCatsInfo(binding.threadId, this.deps);
  }

  private async handleStatus(connectorId: string, externalChatId: string): Promise<CommandResult> {
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return { kind: 'status', response: '⚠️ 当前没有绑定 thread，请先用 /new 创建或 /use 切换。' };
    }
    const thread = await this.deps.threadStore.get(binding.threadId);
    if (!thread) {
      return { kind: 'status', response: '⚠️ 绑定的 thread 已不存在。' };
    }
    return buildStatusInfo(binding.threadId, thread, this.deps);
  }

  private async handleUnbind(connectorId: string, externalChatId: string): Promise<CommandResult> {
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return { kind: 'unbind', response: '⚠️ 当前没有绑定。发送消息或用 /new 创建新 thread。' };
    }
    const thread = await this.deps.threadStore.get(binding.threadId);
    const title = thread?.title ?? '(无标题)';
    await this.deps.bindingStore.remove(connectorId, externalChatId);
    return {
      kind: 'unbind',
      response: `🔓 已解绑: ${title} [${binding.threadId}]\n\n下一条消息会自动创建新 thread，或用 /use 切换到已有 thread。`,
    };
  }

  // --- Phase D: permission commands ---

  private async isAdminSender(connectorId: string, senderId?: string): Promise<boolean> {
    if (!senderId || !this.deps.permissionStore) return false;
    return this.deps.permissionStore.isAdmin(connectorId, senderId);
  }

  private async handleAllowGroup(
    connectorId: string,
    externalChatId: string,
    senderId?: string,
    chatIdArg?: string,
  ): Promise<CommandResult> {
    if (!(await this.isAdminSender(connectorId, senderId))) {
      return { kind: 'allow-group', response: '🔒 此命令仅管理员可用。' };
    }
    const store = this.deps.permissionStore;
    if (!store) {
      return { kind: 'allow-group', response: '⚠️ 权限系统未启用。' };
    }
    const targetChatId = chatIdArg?.trim() || externalChatId;
    await store.allowGroup(connectorId, targetChatId);
    const groups = await store.listAllowedGroups(connectorId);
    return {
      kind: 'allow-group',
      response: `✅ 群 ${targetChatId.slice(-8)} 已加入白名单（共 ${groups.length} 个群）`,
    };
  }

  private async handleDenyGroup(
    connectorId: string,
    externalChatId: string,
    senderId?: string,
    chatIdArg?: string,
  ): Promise<CommandResult> {
    if (!(await this.isAdminSender(connectorId, senderId))) {
      return { kind: 'deny-group', response: '🔒 此命令仅管理员可用。' };
    }
    const store = this.deps.permissionStore;
    if (!store) {
      return { kind: 'deny-group', response: '⚠️ 权限系统未启用。' };
    }
    const targetChatId = chatIdArg?.trim() || externalChatId;
    const removed = await store.denyGroup(connectorId, targetChatId);
    return {
      kind: 'deny-group',
      response: removed
        ? `🚫 群 ${targetChatId.slice(-8)} 已从白名单移除`
        : `⚠️ 群 ${targetChatId.slice(-8)} 不在白名单中`,
    };
  }

  // ── #687: /history — round-based thread history ────────────────────────

  private async handleHistory(
    connectorId: string,
    externalChatId: string,
    _userId: string,
    args: string,
  ): Promise<CommandResult> {
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return { kind: 'history', response: '📍 当前没有绑定的 thread。用 /new 创建或发送消息自动创建。' };
    }

    const rawArg = args.trim();
    if (rawArg && !/^[1-5]$/.test(rawArg)) {
      return { kind: 'history', response: '❌ 用法: /history [1-5]（默认 1 轮）', contextThreadId: binding.threadId };
    }
    const roundCount = rawArg ? parseInt(rawArg, 10) : 1;

    if (!this.deps.messageStore) {
      return { kind: 'history', response: '❌ 消息存储不可用', contextThreadId: binding.threadId };
    }

    type Msg = Awaited<ReturnType<NonNullable<typeof this.deps.messageStore>['getByThreadBefore']>>[number];
    const SYSTEM_UIDS = new Set(['system', 'scheduler']);
    const isUserMsg = (m: Msg): boolean => m.catId === null && !SYSTEM_UIDS.has(m.userId ?? '');
    const splitRounds = (msgs: Msg[]): Msg[][] => {
      const result: Msg[][] = [];
      let cur: Msg[] = [];
      for (const m of msgs) {
        if (isUserMsg(m) && cur.length > 0) {
          result.push(cur);
          cur = [];
        }
        cur.push(m);
      }
      if (cur.length > 0) result.push(cur);
      return result;
    };

    // AC-8: cursor-based windowed fetch; floor 200 covers A2A-heavy rounds
    const fetchLimit = Math.max(200, roundCount * 100);
    const messages = await this.deps.messageStore.getByThreadBefore(binding.threadId, Date.now(), fetchLimit);
    if (messages.length === 0) {
      return { kind: 'history', response: '📜 本线程还没有消息。', contextThreadId: binding.threadId };
    }
    const rounds = splitRounds(messages);
    const selected = rounds.slice(-roundCount);

    const PLATFORM_BUDGET: Record<string, number> = {
      feishu: 10000,
      dingtalk: 6000,
      telegram: 4000,
      'wecom-bot': 2000,
      'wecom-agent': 2000,
      weixin: 2000,
    };
    const TOTAL_BUDGET = PLATFORM_BUDGET[connectorId] ?? 2000;
    const roster = this.deps.catRoster;
    const resolveSender = (msg: Msg): string => {
      if (msg.catId) {
        const display = roster?.[msg.catId]?.displayName;
        return `🐱 ${display ?? msg.catId}`;
      }
      if (SYSTEM_UIDS.has(msg.userId ?? '')) return '🔔 系统';
      return '👤 你';
    };

    const header = roundCount === 1 ? '📜 最近 1 轮对话：' : `📜 最近 ${selected.length} 轮对话：`;
    const deepLink = buildThreadDeepLink(this.deps.frontendBaseUrl, binding.threadId);
    const footerText = `\n\n⚠️ 内容已精简，完整对话请打开 thread\n🔗 ${deepLink}`;

    // P1-1: pre-compute per-message metadata for overhead-aware budget
    const allMsgs = selected.flat();
    const meta = allMsgs.map((msg) => {
      const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return { msg, prefix: `**${resolveSender(msg)}** [${time}]: ` };
    });

    // Deduct header, line prefixes, separators, join newlines, truncation markers, footer reserve
    const separatorCount = selected.length - 1;
    const totalLineCount = meta.length + separatorCount;
    const overhead =
      header.length +
      2 +
      meta.reduce((s, m) => s + m.prefix.length, 0) +
      separatorCount * 3 +
      (totalLineCount > 1 ? totalLineCount - 1 : 0) +
      meta.length +
      footerText.length;
    const contentBudget = Math.max(0, TOTAL_BUDGET - overhead);
    // Progressive distribution: short messages keep full content, savings go to longer ones
    const sortedLens = meta.map(({ msg }) => msg.content.length).sort((a, b) => a - b);
    let budgetLeft = contentBudget;
    let countLeft = sortedLens.length;
    let perMsgBudget = Infinity;
    for (const len of sortedLens) {
      const share = Math.floor(budgetLeft / countLeft);
      if (len <= share) {
        budgetLeft -= len;
        countLeft--;
      } else {
        perMsgBudget = Math.max(20, share);
        break;
      }
    }

    let anyTruncated = false;
    const lines: string[] = [];
    let metaIdx = 0;
    for (const round of selected) {
      for (let i = 0; i < round.length; i++) {
        const { msg, prefix } = meta[metaIdx++]!;
        let content = msg.content;
        if (content.length > perMsgBudget) {
          content = content.slice(0, perMsgBudget) + '…';
          anyTruncated = true;
        }
        lines.push(`${prefix}${content}`);
      }
      lines.push('---');
    }
    if (lines[lines.length - 1] === '---') lines.pop();

    const footer = anyTruncated ? footerText : '';
    let response = `${header}\n\n${lines.join('\n')}${footer}`;

    // Hard cap safety net
    if (response.length > TOTAL_BUDGET) {
      response = response.slice(0, TOTAL_BUDGET - footerText.length) + footerText;
    }

    return {
      kind: 'history',
      response,
      contextThreadId: binding.threadId,
    };
  }

  // ── F154: /focus — set/view/clear preferred cat ────────────────────────

  private async handleFocus(
    connectorId: string,
    externalChatId: string,
    _userId: string,
    args: string,
  ): Promise<CommandResult> {
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return { kind: 'focus', response: '📍 当前没有绑定的 thread。先发送消息创建 thread 后再使用 /focus。' };
    }
    const thread = await this.deps.threadStore.get(binding.threadId);
    const trimmed = args.trim();

    // /focus (no args) — query current preferred cat
    if (!trimmed) {
      const preferred = thread?.preferredCats;
      if (preferred && preferred.length > 0) {
        return { kind: 'focus', response: `🐱 当前首选猫：${preferred.join(', ')}` };
      }
      return { kind: 'focus', response: '🐾 当前未设置首选猫，使用全局默认。' };
    }

    // /focus clear — clear preferred cats
    if (trimmed === 'clear') {
      await this.deps.threadStore.updatePreferredCats?.(binding.threadId, []);
      return { kind: 'focus', response: '✅ 已清除首选猫设置，回到全局默认。' };
    }

    // /focus <catName> — set preferred cat (single, KD-5)
    const resolved = normalizeCatId(trimmed);
    if (!resolved.ok) {
      if (resolved.reason === 'ambiguous') {
        return {
          kind: 'focus',
          response: `🤔 找到多只匹配的猫：${resolved.candidates.join(', ')}，请输入更精确的名字。`,
        };
      }
      return { kind: 'focus', response: `❌ 找不到猫「${resolved.input}」。` };
    }
    await this.deps.threadStore.updatePreferredCats?.(binding.threadId, [String(resolved.catId)]);
    return { kind: 'focus', response: `🐱 已将首选猫设为 ${resolved.catId}` };
  }

  // ── F154: /ask — one-shot directed routing (KD-4: normal pipeline) ────

  private async handleAsk(
    connectorId: string,
    externalChatId: string,
    _userId: string,
    args: string,
  ): Promise<CommandResult> {
    // F154 P1-2 fix: check binding exists before claiming success
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      return { kind: 'ask', response: '📍 当前没有绑定的 thread，请先发送消息创建 thread。' };
    }

    const parts = args.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0]) {
      return { kind: 'ask', response: '用法：/ask <猫名> <消息>' };
    }
    const [catInput, ...msgParts] = parts;
    const message = msgParts.join(' ');

    const resolved = normalizeCatId(catInput);
    if (!resolved.ok) {
      if (resolved.reason === 'ambiguous') {
        return {
          kind: 'ask',
          response: `🤔 找到多只匹配的猫：${resolved.candidates.join(', ')}，请输入更精确的名字。`,
        };
      }
      return { kind: 'ask', response: `❌ 找不到猫「${resolved.input}」。` };
    }

    return {
      kind: 'ask',
      response: `🎯 已定向发送给 ${resolved.catId}`,
      forwardContent: message,
      targetCatId: String(resolved.catId),
    };
  }
}
