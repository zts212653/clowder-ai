/**
 * Helper functions for ConnectorCommandLayer.
 * Extracted to keep the main class file under the 350-line limit.
 */

import type { CommandRegistry } from '../commands/CommandRegistry.js';
import type { CommandResult } from './ConnectorCommandLayer.js';

// --- F142: command info handlers ---

interface CatRosterEntry {
  displayName: string;
  available?: boolean;
}

export interface CommandInfoDeps {
  participantStore?: {
    getParticipantsWithActivity(
      threadId: string,
    ):
      | Array<{ catId: string; lastMessageAt: number; messageCount: number }>
      | Promise<Array<{ catId: string; lastMessageAt: number; messageCount: number }>>;
  };
  agentRegistry?: { has(catId: string): boolean };
  catRoster?: Record<string, CatRosterEntry>;
  frontendBaseUrl: string;
}

/** AC-B7: structured audit log for slash command execution */
export function auditSlashCommand(trimmed: string, duration: number, registry?: CommandRegistry): void {
  const cmd = trimmed.split(/\s+/)[0]?.toLowerCase();
  const src = (cmd && registry?.get(cmd)?.source) ?? 'core';
  console.log(
    JSON.stringify({
      event: 'slash_command',
      command: cmd,
      surface: 'connector',
      source: src,
      duration,
      success: true,
    }),
  );
}

/** Hardcoded fallback when no registry is available */
const FALLBACK_COMMANDS = [
  { cmd: '/commands', desc: '列出所有可用命令' },
  { cmd: '/cats', desc: '查看当前 thread 的猫猫' },
  { cmd: '/status', desc: '查看当前 thread 状态' },
  { cmd: '/where', desc: '查看当前绑定的 thread' },
  { cmd: '/new [标题]', desc: '创建新 thread 并切换' },
  { cmd: '/threads', desc: '列出最近的 threads' },
  { cmd: '/use <F号|序号|关键词>', desc: '切换到指定 thread' },
  { cmd: '/thread <id> <消息>', desc: '切换并发送消息' },
  { cmd: '/unbind', desc: '解除当前绑定' },
];

export function buildCommandsList(registry?: CommandRegistry): CommandResult {
  // F142-B: dynamic listing from registry when available
  const commands = registry
    ? registry.listBySurface('connector').map((c) => ({ cmd: c.usage || c.name, desc: c.description }))
    : FALLBACK_COMMANDS;
  const lines = commands.map((c) => `  ${c.cmd} — ${c.desc}`);
  return { kind: 'commands', response: `📋 可用命令：\n\n${lines.join('\n')}` };
}

export async function buildCatsInfo(threadId: string, deps: CommandInfoDeps): Promise<CommandResult> {
  const roster = deps.catRoster ?? {};
  const participantActivity = (await deps.participantStore?.getParticipantsWithActivity(threadId)) ?? [];
  const allCatIds = Object.keys(roster);
  const participantIds = new Set(participantActivity.map((p) => p.catId));
  const lines: string[] = [];

  if (participantActivity.length > 0) {
    lines.push('🐾 参与猫：');
    for (const p of participantActivity) {
      const available = roster[p.catId]?.available !== false;
      const routable = available && (deps.agentRegistry?.has(p.catId) ?? false);
      const name = roster[p.catId]?.displayName ?? p.catId;
      lines.push(`  ${routable ? '✅' : '⚠️'} ${name}（${p.messageCount} 条消息）`);
    }
  }

  const routableNotJoined = allCatIds.filter(
    (id) => !participantIds.has(id) && roster[id]?.available !== false && (deps.agentRegistry?.has(id) ?? false),
  );
  if (routableNotJoined.length > 0) {
    lines.push('\n📡 可调度（未加入）：');
    for (const id of routableNotJoined) lines.push(`  ${roster[id]?.displayName ?? id}`);
  }

  const notRoutable = allCatIds.filter((id) => !participantIds.has(id) && roster[id]?.available === false);
  if (notRoutable.length > 0) {
    lines.push('\n💤 不可调度：');
    for (const id of notRoutable) lines.push(`  ${roster[id]?.displayName ?? id}`);
  }

  return {
    kind: 'cats',
    response: lines.join('\n') || '没有找到猫猫。',
    contextThreadId: threadId,
  };
}

export async function buildStatusInfo(
  threadId: string,
  thread: { title?: string | null; createdAt?: number; preferredCats?: string[] },
  deps: CommandInfoDeps,
): Promise<CommandResult> {
  const participants = (await deps.participantStore?.getParticipantsWithActivity(threadId)) ?? [];
  const lastActive = participants.length > 0 ? timeAgo(Math.max(...participants.map((p) => p.lastMessageAt))) : '未知';

  const title = thread.title || '(无标题)';
  const created = new Date(thread.createdAt ?? 0).toLocaleDateString('zh-CN');
  const link = `${deps.frontendBaseUrl}/thread/${threadId}`;

  const lines = [
    '📊 Thread 状态',
    `  标题：${title}`,
    `  创建：${created}`,
    `  参与猫：${participants.length} 只`,
    `  最近活跃：${lastActive}`,
  ];

  // F154 Phase B (AC-B3): show preferred cat info
  const preferred = thread.preferredCats;
  if (preferred && preferred.length > 0) {
    const names = preferred.map((id) => deps.catRoster?.[id]?.displayName ?? id);
    lines.push(`  首选猫：${names.join(', ')}`);
  }

  lines.push(`  🔗 ${link}`);

  return {
    kind: 'status',
    response: lines.join('\n'),
    contextThreadId: threadId,
  };
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

// --- Phase D: matching helpers ---

interface ThreadEntry {
  id: string;
  title?: string | null;
  lastActiveAt?: number;
  backlogItemId?: string;
}

interface BacklogStore {
  get(
    itemId: string,
    userId?: string,
  ): { tags: readonly string[] } | null | Promise<{ tags: readonly string[] } | null>;
}

/** Match by feature number (e.g., /use F088). Async because it needs backlogStore. */
export async function matchByFeatId(
  input: string,
  threads: ThreadEntry[],
  userId: string,
  backlogStore?: BacklogStore,
): Promise<ThreadEntry | null> {
  if (!/^F\d+$/i.test(input)) return null;
  if (!backlogStore) return null;
  const targetFeat = input.toUpperCase();
  const matches: ThreadEntry[] = [];
  for (const t of threads) {
    if (!t.backlogItemId) continue;
    const item = await backlogStore.get(t.backlogItemId, userId);
    if (!item) continue;
    if (extractFeatIds(item.tags).includes(targetFeat)) matches.push(t);
  }
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => ((a.lastActiveAt ?? 0) >= (b.lastActiveAt ?? 0) ? a : b));
}

/** Match by 1-based index from /threads listing. */
export function matchByListIndex(input: string, threads: ThreadEntry[]): ThreadEntry | null {
  if (!/^\d+$/.test(input)) return null;
  const idx = Number.parseInt(input, 10);
  const list = threads.slice(0, 10);
  if (idx < 1 || idx > list.length) return null;
  return list[idx - 1] ?? null;
}

/** Match by thread ID prefix. */
export function matchByIdPrefix(input: string, threads: ThreadEntry[]): ThreadEntry | null {
  return threads.find((t) => t.id.startsWith(input)) ?? null;
}

/** Match by thread title substring (case-insensitive). */
export function matchByTitle(input: string, threads: ThreadEntry[]): ThreadEntry | null {
  const query = input.toLowerCase();
  const matches = threads.filter((t) => t.title?.toLowerCase().includes(query));
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => ((a.lastActiveAt ?? 0) >= (b.lastActiveAt ?? 0) ? a : b));
}

/** Extract ALL normalized feat IDs from backlog item tags. */
export function extractFeatIds(tags: readonly string[]): string[] {
  const feats: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith('feature:')) feats.push(tag.slice('feature:'.length).toUpperCase());
  }
  return feats;
}

/** Resolve feat badges for threads (used by /threads display). */
export async function resolveFeatBadges(
  threads: ThreadEntry[],
  userId: string,
  backlogStore?: BacklogStore,
): Promise<Map<string, string>> {
  const badges = new Map<string, string>();
  if (!backlogStore) return badges;
  for (const t of threads) {
    if (!t.backlogItemId) continue;
    const item = await backlogStore.get(t.backlogItemId, userId);
    if (!item) continue;
    const featIds = extractFeatIds(item.tags);
    if (featIds.length > 0) badges.set(t.id, featIds.join(','));
  }
  return badges;
}
