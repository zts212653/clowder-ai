/**
 * Event Audit Log
 * Append-only 事件日志，用于记录关键里程碑。
 *
 * 设计原则：
 * - 只追加，不可修改 (append-only)
 * - 每个事件都有唯一 ID 和时间戳
 * - 文件名按日期分片，便于归档
 * - 即使 Redis 丢失，真相仍可追溯
 *
 * 使用场景：
 * - 辩论冠军宣判
 * - Phase 完成
 * - 重要决策
 * - Review 批准
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createModuleLogger } from '../../../../infrastructure/logger.js';

const log = createModuleLogger('audit');

export interface AuditEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly threadId?: string;
  readonly data: Record<string, unknown>;
  /** Optional hash signature for integrity verification */
  readonly signature?: string;
}

export type AuditEventInput = Omit<AuditEvent, 'id' | 'timestamp'>;

/** Default audit log directory */
const DEFAULT_AUDIT_DIR = './data/audit-logs';

export class EventAuditLog {
  private readonly auditDir: string;
  private initialized = false;

  constructor(options?: { auditDir?: string }) {
    this.auditDir = options?.auditDir ?? process.env.AUDIT_LOG_DIR ?? DEFAULT_AUDIT_DIR;
  }

  /**
   * Append an event to the audit log.
   * Returns the created event with generated ID and timestamp.
   */
  async append(input: AuditEventInput): Promise<AuditEvent> {
    await this.ensureInitialized();

    const event: AuditEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...input,
    };

    const filename = this.getFilename(event.timestamp);
    const filepath = join(this.auditDir, filename);
    const line = `${JSON.stringify(event)}\n`;

    await appendFile(filepath, line, 'utf-8');

    return event;
  }

  /**
   * Read all events from a specific date.
   * @param date Date string in YYYY-MM-DD format, or Date object
   */
  async readByDate(date: string | Date): Promise<AuditEvent[]> {
    await this.ensureInitialized();

    const dateStr = typeof date === 'string' ? date : this.formatDate(date);
    const filename = `audit-${dateStr}.ndjson`;
    const filepath = join(this.auditDir, filename);

    if (!existsSync(filepath)) {
      return [];
    }

    const content = await readFile(filepath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const events: AuditEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        log.error({ linePreview: line.slice(0, 100) }, 'Failed to parse audit line');
      }
    }

    return events;
  }

  /**
   * Read all events of a specific type.
   */
  async readByType(type: string, options?: { days?: number }): Promise<AuditEvent[]> {
    const days = options?.days ?? 30;
    const events: AuditEvent[] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayEvents = await this.readByDate(date);
      events.push(...dayEvents.filter((e) => e.type === type));
    }

    return events.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Read all events for a specific thread.
   */
  async readByThread(threadId: string, options?: { days?: number }): Promise<AuditEvent[]> {
    const days = options?.days ?? 30;
    const events: AuditEvent[] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayEvents = await this.readByDate(date);
      events.push(...dayEvents.filter((e) => e.threadId === threadId));
    }

    return events.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get the absolute path to today's audit log file.
   */
  getLogPath(): string {
    const filename = this.getFilename(Date.now());
    return resolve(this.auditDir, filename);
  }

  /**
   * List all available audit log files.
   */
  async listFiles(): Promise<string[]> {
    await this.ensureInitialized();

    const files = await readdir(this.auditDir);
    return files
      .filter((f) => f.startsWith('audit-') && f.endsWith('.ndjson'))
      .sort()
      .reverse();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (!existsSync(this.auditDir)) {
      await mkdir(this.auditDir, { recursive: true });
      log.info({ dir: this.auditDir }, 'Created audit log directory');
    }

    this.initialized = true;
  }

  private getFilename(timestamp: number): string {
    const date = this.formatDate(new Date(timestamp));
    return `audit-${date}.ndjson`;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/** Common event types for Clowder AI */
export const AuditEventTypes = {
  /** 辩论/讨论冠军宣判 */
  DEBATE_WINNER: 'debate_winner',
  /** Phase 完成 */
  PHASE_COMPLETED: 'phase_completed',
  /** Code review 批准 */
  REVIEW_APPROVED: 'review_approved',
  /** 重要决策 */
  DECISION_MADE: 'decision_made',
  /** 对话创建 */
  THREAD_CREATED: 'thread_created',
  /** 对话删除 (I-2: 删除操作审计) */
  THREAD_DELETED: 'thread_deleted',
  /** 任务提取完成 */
  TASKS_EXTRACTED: 'tasks_extracted',
  /** 服务器启动 */
  SERVER_STARTED: 'server_started',
  /** 服务器关闭 */
  SERVER_SHUTDOWN: 'server_shutdown',
  /** 运行时配置被更新 */
  CONFIG_UPDATED: 'config_updated',

  // === 消息级审计 (茶话会夺魂 bug fix #37) ===

  /** 猫被调用 (CLI spawn 前) */
  CAT_INVOKED: 'cat_invoked',
  /** 猫响应完成 (done 消息后) */
  CAT_RESPONDED: 'cat_responded',
  /** 调用发生错误 */
  CAT_ERROR: 'cat_error',
  /** 猫猫互调 handoff */
  A2A_HANDOFF: 'a2a_handoff',
  /** CLI 工具执行开始（command_execution started） */
  CLI_TOOL_STARTED: 'cli_tool_started',
  /** CLI 工具执行完成（command_execution completed） */
  CLI_TOOL_COMPLETED: 'cli_tool_completed',

  // === 记忆治理 (Phase 5.0 Step 2a) ===

  /** 记忆提交审核 (draft → pending_review) */
  MEMORY_PUBLISH_SUBMITTED: 'memory_publish_submitted',
  /** 记忆审核通过 (pending_review → published) */
  MEMORY_PUBLISH_APPROVED: 'memory_publish_approved',
  /** 记忆归档 (published → archived) */
  MEMORY_PUBLISH_ARCHIVED: 'memory_publish_archived',
  /** 记忆回滚 (published → draft) */
  MEMORY_PUBLISH_ROLLBACK: 'memory_publish_rollback',

  // === Session Chain (F24 Phase B) ===

  /** 手动绑定 CLI session (#72) */
  SESSION_BIND: 'session_bind',

  // === Push Delivery Diagnostics ===

  /** 用户触发测试推送 */
  PUSH_TEST_REQUESTED: 'push_test_requested',
  /** 测试推送结果（成功/失败 + delivery summary） */
  PUSH_TEST_RESULT: 'push_test_result',
  /** 订阅成功写入 */
  PUSH_SUBSCRIPTION_UPSERTED: 'push_subscription_upserted',
  /** 订阅移除 */
  PUSH_SUBSCRIPTION_REMOVED: 'push_subscription_removed',

  // === Browser Preview (F120) ===

  /** 浏览器预览打开 */
  BROWSER_PREVIEW_OPEN: 'browser_preview_open',
  /** 浏览器预览关闭 */
  BROWSER_PREVIEW_CLOSE: 'browser_preview_close',
  /** 浏览器预览导航 */
  BROWSER_PREVIEW_NAVIGATE: 'browser_preview_navigate',

  // === Session Sealing (F118) ===

  /** finalize() failed or timed out */
  SEAL_FINALIZE_FAILED: 'seal_finalize_failed',
} as const;

/** Singleton instance for convenience */
let defaultInstance: EventAuditLog | null = null;

export function getEventAuditLog(): EventAuditLog {
  if (!defaultInstance) {
    defaultInstance = new EventAuditLog();
  }
  return defaultInstance;
}
