import type { IConnectorPermissionStore } from './ConnectorPermissionStore.js';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';

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
    | 'not-command';
  readonly response?: string;
  readonly newActiveThreadId?: string;
  /** Thread context for storing command exchange in messageStore */
  readonly contextThreadId?: string;
  /** Message content to forward to target thread after switching (used by /thread) */
  readonly forwardContent?: string;
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
      | { id: string; title?: string | null; createdAt?: number }
      | null
      | Promise<{ id: string; title?: string | null; createdAt?: number } | null>;
    /** List threads owned by userId (sorted by lastActiveAt desc). Phase C: cross-platform thread view */
    list(userId: string): ThreadEntry[] | Promise<ThreadEntry[]>;
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

    const [rawCmd, ...args] = trimmed.split(/\s+/);
    const cmd = rawCmd?.toLowerCase();
    switch (cmd) {
      case '/where':
        return this.handleWhere(connectorId, externalChatId);
      case '/new':
        return this.handleNew(connectorId, externalChatId, userId, args.join(' '));
      case '/threads':
        return this.handleThreads(connectorId, externalChatId, userId);
      case '/use':
        return this.handleUse(connectorId, externalChatId, userId, args.join(' '));
      case '/thread':
        return this.handleThread(connectorId, externalChatId, userId, args);
      case '/unbind':
        return this.handleUnbind(connectorId, externalChatId);
      case '/allow-group':
        return this.handleAllowGroup(connectorId, externalChatId, senderId, args.join(' '));
      case '/deny-group':
        return this.handleDenyGroup(connectorId, externalChatId, senderId, args.join(' '));
      default:
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
    const deepLink = `${this.deps.frontendBaseUrl}/threads/${binding.threadId}`;
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
    const deepLink = `${this.deps.frontendBaseUrl}/threads/${thread.id}`;
    const titleDisplay = effectiveTitle ? ` "${effectiveTitle}"` : '';
    return {
      kind: 'new',
      newActiveThreadId: thread.id,
      contextThreadId: thread.id,
      response: `✨ 新 thread${titleDisplay} 已创建\nID: ${thread.id}\n🔗 ${deepLink}\n\n现在的消息会发到这个 thread。`,
    };
  }

  private async handleThreads(connectorId: string, externalChatId: string, userId: string): Promise<CommandResult> {
    // Phase C: cross-platform thread view — show ALL user threads, not just current connector
    const allThreads = await this.deps.threadStore.list(userId);
    const threads = allThreads.slice(0, 10);
    // Look up current binding so the command exchange lands in the right thread
    const binding = await this.deps.bindingStore.getByExternal(connectorId, externalChatId);
    if (threads.length === 0) {
      return { kind: 'threads', response: '📋 还没有 thread。发送消息或用 /new 创建一个吧！' };
    }
    // Phase D: resolve feat badges for threads with backlogItemId
    const featBadges = await this.resolveFeatBadges(threads, userId);
    const lines = threads.map((t, i) => {
      const title = t.title ?? '(无标题)';
      const badge = featBadges.get(t.id);
      return badge ? `${i + 1}. ${title} [${badge}] [${t.id}]` : `${i + 1}. ${title} [${t.id}]`;
    });
    const result: CommandResult = {
      kind: 'threads',
      response: `📋 最近的 threads:\n\n${lines.join('\n')}\n\n用 /use F088 或 /use 关键词 或 /use 3 切换`,
    };
    if (binding) {
      return { ...result, contextThreadId: binding.threadId };
    }
    return result;
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

    // Phase D: cascade matching (feat号 → 列表序号 → ID前缀 → title关键词)
    const match =
      (await this.matchByFeatId(input, allThreads, userId)) ??
      this.matchByListIndex(input, allThreads) ??
      this.matchByIdPrefix(input, allThreads) ??
      this.matchByTitle(input, allThreads);

    if (!match) {
      return { kind: 'use', response: `❌ 找不到匹配 "${input}" 的 thread。用 /threads 查看可用列表。` };
    }
    await this.deps.bindingStore.bind(connectorId, externalChatId, match.id, userId);
    const title = match.title ?? '(无标题)';
    const deepLink = `${this.deps.frontendBaseUrl}/threads/${match.id}`;
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

    // Match only within user's own threads (exact ID → prefix)
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

  // --- Phase D: matching helpers ---

  /** Match by feature number (e.g., /use F088). Async because it needs backlogStore. */
  private async matchByFeatId(input: string, threads: ThreadEntry[], userId: string): Promise<ThreadEntry | null> {
    if (!/^F\d+$/i.test(input)) return null;
    const { backlogStore } = this.deps;
    if (!backlogStore) return null;
    const targetFeat = input.toUpperCase();
    const matches: ThreadEntry[] = [];
    for (const t of threads) {
      if (!t.backlogItemId) continue;
      const item = await backlogStore.get(t.backlogItemId, userId);
      if (!item) continue;
      const featTags = this.extractFeatIds(item.tags);
      if (featTags.includes(targetFeat)) matches.push(t);
    }
    if (matches.length === 0) return null;
    // Multiple threads for same feat → pick most recently active
    return matches.reduce((a, b) => ((a.lastActiveAt ?? 0) >= (b.lastActiveAt ?? 0) ? a : b));
  }

  /** Match by 1-based index from /threads listing (e.g., /use 3). */
  private matchByListIndex(input: string, threads: ThreadEntry[]): ThreadEntry | null {
    if (!/^\d+$/.test(input)) return null;
    const idx = parseInt(input, 10);
    const list = threads.slice(0, 10); // Same slice as /threads output
    if (idx < 1 || idx > list.length) return null;
    return list[idx - 1] ?? null;
  }

  /** Match by thread ID prefix (existing Phase C behavior). */
  private matchByIdPrefix(input: string, threads: ThreadEntry[]): ThreadEntry | null {
    return threads.find((t) => t.id.startsWith(input)) ?? null;
  }

  /** Match by thread title substring (case-insensitive). */
  private matchByTitle(input: string, threads: ThreadEntry[]): ThreadEntry | null {
    const query = input.toLowerCase();
    const matches = threads.filter((t) => t.title?.toLowerCase().includes(query));
    if (matches.length === 0) return null;
    // Multiple matches → pick most recently active
    return matches.reduce((a, b) => ((a.lastActiveAt ?? 0) >= (b.lastActiveAt ?? 0) ? a : b));
  }

  /** Extract ALL normalized feat IDs from backlog item tags. Returns e.g. ['F066', 'F088'] or empty array. */
  private extractFeatIds(tags: readonly string[]): string[] {
    const feats: string[] = [];
    for (const tag of tags) {
      if (tag.startsWith('feature:')) feats.push(tag.slice('feature:'.length).toUpperCase());
    }
    return feats;
  }

  /** Resolve feat badges for threads (used by /threads display). */
  private async resolveFeatBadges(threads: ThreadEntry[], userId: string): Promise<Map<string, string>> {
    const badges = new Map<string, string>();
    const { backlogStore } = this.deps;
    if (!backlogStore) return badges;
    for (const t of threads) {
      if (!t.backlogItemId) continue;
      const item = await backlogStore.get(t.backlogItemId, userId);
      if (!item) continue;
      const featIds = this.extractFeatIds(item.tags);
      if (featIds.length > 0) badges.set(t.id, featIds.join(','));
    }
    return badges;
  }
}
