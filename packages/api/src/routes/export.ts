/**
 * Export Routes
 * GET /api/export/thread/:threadId?format=md|txt - 导出对话记录
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { formatMessage, getSenderName } from '../domains/cats/services/context/ContextAssembler.js';
import {
  MessageSelectionResolver,
  type ResolvedMessageSelectionItem,
} from '../domains/cats/services/context/MessageSelectionResolver.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const pad = (n: number) => n.toString().padStart(2, '0');

/**
 * Format date consistently across environments (no locale dependency).
 * Output: YYYY-MM-DD HH:mm (host-local).
 */
function formatDatetime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Local HH:mm passed to formatMessage() so the message body shares
 * formatDatetime's host-local basis. Without this, the prompt default
 * (UTC with "UTC" marker) would leak into the export and disagree with the
 * local header/footer in the same document (P1 from review on 2026-05-29).
 */
function formatLocalTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ExportRoutesOptions {
  messageStore: IMessageStore;
  threadStore: IThreadStore;
}

/**
 * Format a thread as Markdown document.
 * Reuses formatMessage() from ContextAssembler for consistent [HH:MM 角色名] format.
 */
export function formatThreadAsMarkdown(thread: Thread, messages: StoredMessage[]): string {
  const lines: string[] = [];

  // Header
  const title = thread.title ?? '未命名对话';
  lines.push(`# 对话记录: ${title}`, '');

  // Meta
  lines.push(`- **ID**: ${thread.id}`);
  if (messages.length > 0) {
    const first = formatDatetime(new Date(messages[0]?.timestamp));
    const last = formatDatetime(new Date(messages[messages.length - 1]?.timestamp));
    lines.push(`- **时间**: ${first} ~ ${last}`);
  }
  if (thread.participants.length > 0) {
    const names = thread.participants.map((id) => {
      const entry = catRegistry.tryGet(id);
      return entry?.config.displayName ?? id;
    });
    lines.push(`- **参与者**: ${names.join(', ')}`);
  }
  lines.push(`- **消息数**: ${messages.length}`, '', '---', '');

  // Messages — full content (no truncation)
  for (const msg of messages) {
    const line = formatMessage(msg, { formatTime: formatLocalTime });
    lines.push(line);
    // Append metadata tag for cat messages
    if (msg.metadata) {
      const parts: string[] = [];
      if (msg.metadata.provider) parts.push(msg.metadata.provider);
      if (msg.metadata.model) parts.push(msg.metadata.model);
      if (parts.length > 0) {
        lines.push(`*[${parts.join('/')}]*`);
      }
    }
  }

  lines.push('', '---', `*导出时间: ${formatDatetime(new Date())}*`);
  return lines.join('\n');
}

/**
 * Format a thread as plain text (no Markdown syntax).
 * Same structure as Markdown but without formatting markers.
 */
export function formatThreadAsText(thread: Thread, messages: StoredMessage[]): string {
  const lines: string[] = [];

  const title = thread.title ?? '未命名对话';
  lines.push(`对话记录: ${title}`, '');

  lines.push(`ID: ${thread.id}`);
  if (messages.length > 0) {
    const first = formatDatetime(new Date(messages[0]?.timestamp));
    const last = formatDatetime(new Date(messages[messages.length - 1]?.timestamp));
    lines.push(`时间: ${first} ~ ${last}`);
  }
  if (thread.participants.length > 0) {
    const names = thread.participants.map((id) => {
      const entry = catRegistry.tryGet(id);
      return entry?.config.displayName ?? id;
    });
    lines.push(`参与者: ${names.join(', ')}`);
  }
  lines.push(`消息数: ${messages.length}`, '', '---', '');

  for (const msg of messages) {
    const line = formatMessage(msg, { formatTime: formatLocalTime });
    lines.push(line);
    if (msg.metadata) {
      const parts: string[] = [];
      if (msg.metadata.provider) parts.push(msg.metadata.provider);
      if (msg.metadata.model) parts.push(msg.metadata.model);
      if (parts.length > 0) {
        lines.push(`[${parts.join('/')}]`);
      }
    }
  }

  lines.push('', '---', `导出时间: ${formatDatetime(new Date())}`);
  return lines.join('\n');
}

function selectionSender(item: ResolvedMessageSelectionItem): string {
  return item.author.kind === 'user' ? 'co-creator' : getSenderName(item.author.catId);
}

export function formatSelectionAsMarkdown(
  thread: Pick<Thread, 'id' | 'title'>,
  items: readonly ResolvedMessageSelectionItem[],
): string {
  const lines = [
    `# 精选聊天记录: ${thread.title ?? '未命名对话'}`,
    '',
    `- **来源 Thread**: ${thread.id}`,
    `- **消息数**: ${items.length}`,
    '',
    '---',
    '',
  ];
  for (const item of items) {
    lines.push(`[${formatLocalTime(item.timestamp)} ${selectionSender(item)}] ${item.readableContent}`);
    lines.push(`*[来源消息: ${item.messageId}]*`);
    if (item.comment) lines.push(`> **Comment:** ${item.comment}`);
    lines.push('');
  }
  lines.push('---', `*导出时间: ${formatDatetime(new Date())}*`);
  return lines.join('\n');
}

export function formatSelectionAsText(
  thread: Pick<Thread, 'id' | 'title'>,
  items: readonly ResolvedMessageSelectionItem[],
): string {
  const lines = [
    `精选聊天记录: ${thread.title ?? '未命名对话'}`,
    '',
    `来源 Thread: ${thread.id}`,
    `消息数: ${items.length}`,
    '',
    '---',
    '',
  ];
  for (const item of items) {
    lines.push(`[${formatLocalTime(item.timestamp)} ${selectionSender(item)}] ${item.readableContent}`);
    lines.push(`来源消息: ${item.messageId}`);
    if (item.comment) lines.push(`Comment: ${item.comment}`);
    lines.push('');
  }
  lines.push('---', `导出时间: ${formatDatetime(new Date())}`);
  return lines.join('\n');
}

const SUPPORTED_FORMATS = new Set(['md', 'txt']);

export const exportRoutes: FastifyPluginAsync<ExportRoutesOptions> = async (app, opts) => {
  const { messageStore, threadStore } = opts;
  const selectionResolver = new MessageSelectionResolver({ messageStore, threadStore });

  // GET /api/export/thread/:threadId?format=md|txt
  app.get('/api/export/thread/:threadId', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const format = (request.query as { format?: string }).format ?? 'md';
    const userId = resolveStrictUserId(request);

    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    if (!SUPPORTED_FORMATS.has(format)) {
      reply.status(400);
      return { error: 'Unsupported format. Use format=md or format=txt' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (thread.createdBy !== userId && thread.createdBy !== 'system') {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const messages = await messageStore.getByThread(threadId, 10000, userId, {
      includeQueuedCatMessages: true,
    });

    if (format === 'txt') {
      const txt = formatThreadAsText(thread, messages);
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="thread-${threadId}.txt"`);
      return txt;
    }

    const md = formatThreadAsMarkdown(thread, messages);
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="thread-${threadId}.md"`);
    return md;
  });

  app.post('/api/export/thread/:threadId/selection', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const body = request.body as { format?: unknown; items?: unknown } | null;
    const format = body?.format;
    if (format !== 'md' && format !== 'txt') {
      reply.status(400);
      return { error: 'Unsupported format. Use format=md or format=txt' };
    }

    const resolution = await selectionResolver.resolveForAdmission(
      { sourceThreadId: threadId, items: body?.items },
      { userId },
    );
    if (resolution.status === 'invalid') {
      reply.status(resolution.reason === 'not_authorized' ? 403 : 400);
      return {
        error: resolution.reason,
        ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
      };
    }

    const content =
      format === 'txt'
        ? formatSelectionAsText(resolution.sourceThread, resolution.items)
        : formatSelectionAsMarkdown(resolution.sourceThread, resolution.items);
    reply.header('Content-Type', format === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="selection-${threadId}.${format}"`);
    return content;
  });
};
