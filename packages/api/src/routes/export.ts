/**
 * Export Routes
 * GET /api/export/thread/:threadId?format=md|txt - 导出对话记录
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { formatMessage } from '../domains/cats/services/context/ContextAssembler.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';

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

const SUPPORTED_FORMATS = new Set(['md', 'txt']);

export const exportRoutes: FastifyPluginAsync<ExportRoutesOptions> = async (app, opts) => {
  const { messageStore, threadStore } = opts;

  // GET /api/export/thread/:threadId?format=md|txt
  app.get('/api/export/thread/:threadId', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const format = (request.query as { format?: string }).format ?? 'md';

    if (!SUPPORTED_FORMATS.has(format)) {
      reply.status(400);
      return { error: 'Unsupported format. Use format=md or format=txt' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const messages = await messageStore.getByThread(threadId, 10000);

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
};
