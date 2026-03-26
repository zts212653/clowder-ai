/**
 * GitHub Review Email Watcher
 * Monitors QQ mail inbox via IMAP for GitHub PR review notifications.
 * When a review is detected, emits an event to trigger cat invocation.
 *
 * BACKLOG #81: https://github.com/zts212653/cat-cafe/issues/81
 */

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { createModuleLogger } from '../logger.js';
import {
  type CatTag,
  catTagToCatId,
  extractCatFromTitle,
  isGithubNotification,
  parseGithubReviewFromSubjectAndSource,
} from './GithubReviewMailParser.js';

const log = createModuleLogger('github-review-watcher');

export interface GithubReviewEvent {
  readonly prNumber: number;
  readonly repository: string;
  readonly title: string;
  readonly reviewType: 'commented' | 'reviewed' | 'approved' | 'changes_requested' | 'unknown';
  readonly reviewer: string | undefined;
  readonly catTag: CatTag | undefined;
  readonly catId: string | undefined;
  readonly emailUid: number;
  readonly receivedAt: Date;
}

export interface GithubReviewWatcherConfig {
  readonly user: string;
  readonly pass: string;
  readonly host: string;
  readonly port: number;
  readonly pollIntervalMs: number;
  readonly proxy?: string;
}

/** Minimal logger interface (compatible with FastifyBaseLogger). */
export interface WatcherLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const defaultLogger: WatcherLogger = {
  info: (msg) => log.info(msg),
  warn: (msg) => log.warn(msg),
  error: (msg) => log.error(msg),
};

/**
 * Handler called for each review event. Returns a promise that resolves
 * when routing succeeds. The watcher only advances its IMAP cursor for
 * UIDs whose handler resolved without throwing (Cloud Codex P1-3 fix).
 */
export type ReviewEventHandler = (event: GithubReviewEvent) => Promise<void>;

type WatcherEventMap = {
  review: [GithubReviewEvent];
  error: [Error];
  connected: [];
  disconnected: [];
};

/** Max reconnect delay (capped exponential backoff). */
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const BASE_RECONNECT_DELAY_MS = 2_000; // 2 seconds

export class GithubReviewWatcher extends EventEmitter<WatcherEventMap> {
  private readonly config: GithubReviewWatcherConfig;
  private readonly log: WatcherLogger;
  private client: ImapFlow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenUid: number = 0;
  private running = false;
  private reviewHandler: ReviewEventHandler | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: GithubReviewWatcherConfig, log?: WatcherLogger) {
    super();
    this.config = config;
    this.log = log ?? defaultLogger;
  }

  /**
   * Register an acknowledged handler. The watcher defers IMAP cursor
   * advancement until this handler resolves for each event.
   */
  onReviewAck(handler: ReviewEventHandler): void {
    this.reviewHandler = handler;
  }

  /**
   * Start watching for GitHub review emails.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log.info('[GithubReviewWatcher] Already running');
      return;
    }

    this.running = true;
    this.log.info('[GithubReviewWatcher] Starting...');

    try {
      await this.connect();
      await this.initializeLastSeenUid();
      this.startPolling();
      this.log.info('[GithubReviewWatcher] Started successfully');
    } catch (error) {
      this.running = false;
      await this.destroyClient(); // Clean up partial connection to prevent leaked sockets
      this.log.error(`[GithubReviewWatcher] Failed to start: ${formatImapError(error)}`);
      throw error;
    }
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.log.info('[GithubReviewWatcher] Stopping...');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await this.destroyClient();

    this.emit('disconnected');
    this.log.info('[GithubReviewWatcher] Stopped');
  }

  private async connect(): Promise<void> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      ...(this.config.proxy ? { proxy: this.config.proxy } : {}),
      logger: false, // Disable verbose logging
    });

    // CRITICAL: attach error handler BEFORE connect() to prevent
    // unhandled 'error' events from crashing the process.
    client.on('error', (err: Error) => {
      this.log.error(`[GithubReviewWatcher] IMAP connection error: ${err.message}`);
      this.handleConnectionLoss();
    });

    client.on('close', () => {
      this.log.warn('[GithubReviewWatcher] IMAP connection closed');
      this.handleConnectionLoss();
    });

    await client.connect();
    this.client = client;
    this.reconnectAttempts = 0; // Reset on successful connect
    this.emit('connected');
    this.log.info('[GithubReviewWatcher] Connected to IMAP server');
  }

  /** Safely tear down the current IMAP client. */
  private async destroyClient(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.logout();
    } catch {
      // Ignore — connection may already be dead
    }
  }

  /**
   * Handle unexpected connection loss: stop polling, schedule reconnect.
   * Idempotent — multiple error/close events won't stack reconnects.
   */
  private handleConnectionLoss(): void {
    if (!this.running) return; // We're shutting down, don't reconnect

    // Prevent stale client from being used in poll()
    this.client = null;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.emit('disconnected');
    this.scheduleReconnect();
  }

  /** Schedule a reconnect with exponential backoff. */
  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return; // Already scheduled or stopping

    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts++;

    this.log.info(
      `[GithubReviewWatcher] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.running) return;

      try {
        await this.destroyClient(); // Clean up any zombie client
        await this.connect();
        this.startPolling();
        this.log.info('[GithubReviewWatcher] Reconnected successfully');
      } catch (error) {
        this.log.error(`[GithubReviewWatcher] Reconnect failed: ${formatImapError(error)}`);
        this.scheduleReconnect(); // Try again with increased backoff
      }
    }, delay);
  }

  private async initializeLastSeenUid(): Promise<void> {
    if (!this.client) return;

    // Open INBOX and get the latest UID
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      // Get mailbox status to find the latest UID
      const status = await this.client.status('INBOX', { uidNext: true });
      // Start from current UID - we only want NEW emails after startup
      this.lastSeenUid = (status.uidNext ?? 1) - 1;
      this.log.info(`[GithubReviewWatcher] Initialized lastSeenUid: ${this.lastSeenUid}`);
    } finally {
      lock.release();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return; // Prevent duplicate intervals
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        this.log.error(`[GithubReviewWatcher] Poll error: ${String(error)}`);
        if (isConnectionError(error)) {
          this.handleConnectionLoss();
        }
      });
    }, this.config.pollIntervalMs);

    // Also poll immediately
    this.poll().catch((error) => {
      this.log.error(`[GithubReviewWatcher] Initial poll error: ${String(error)}`);
      if (isConnectionError(error)) {
        this.handleConnectionLoss();
      }
    });
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.running) return;

    let lock;
    try {
      lock = await this.client.getMailboxLock('INBOX');
    } catch (error) {
      // Connection may have died between the null check and getMailboxLock
      this.log.error(`[GithubReviewWatcher] Failed to acquire mailbox lock: ${formatImapError(error)}`);
      throw error; // Let startPolling's catch handler decide (reconnect or not)
    }

    try {
      // Collect all fetched UIDs in order, tagged as review or skip.
      // We process them sequentially — cursor only advances for UIDs
      // that are successfully handled (Cloud Codex P1-3/P1-4/P1-5).
      const items: Array<{ kind: 'skip'; uid: number } | { kind: 'review'; uid: number; event: GithubReviewEvent }> =
        [];

      for await (const message of this.client.fetch(
        { uid: `${this.lastSeenUid + 1}:*` },
        { uid: true, envelope: true, internalDate: true, source: true },
      )) {
        if (message.uid <= this.lastSeenUid) continue;

        const from = message.envelope?.from?.[0]?.address ?? '';
        if (!isGithubNotification(from)) {
          items.push({ kind: 'skip', uid: message.uid });
          continue;
        }

        const subject = message.envelope?.subject ?? '';
        const sourceText = message.source ? String(message.source) : '';
        const parsed = parseGithubReviewFromSubjectAndSource(subject, sourceText);
        if (!parsed) {
          this.log.info(`[GithubReviewWatcher] Skipping non-review email: ${subject.slice(0, 50)}...`);
          items.push({ kind: 'skip', uid: message.uid });
          continue;
        }

        const catTag = extractCatFromTitle(parsed.title) ?? undefined;
        const rawDate = message.internalDate;
        const receivedAt = rawDate instanceof Date ? rawDate : rawDate ? new Date(rawDate) : new Date();

        items.push({
          kind: 'review',
          uid: message.uid,
          event: {
            ...parsed,
            catTag,
            catId: catTag ? catTagToCatId(catTag) : undefined,
            emailUid: message.uid,
            receivedAt,
          },
        });
      }

      // Sort by UID ascending — IMAP servers typically return in order,
      // but we must not rely on it (砚砚 R3 P1-2).
      items.sort((a, b) => a.uid - b.uid);

      // Process in UID order. Non-review items auto-advance cursor.
      // Review items advance only on handler success; on failure, stop
      // so no later UIDs (review or non-review) skip past the failed one.
      for (const item of items) {
        if (item.kind === 'skip') {
          this.lastSeenUid = Math.max(this.lastSeenUid, item.uid);
          continue;
        }

        this.log.info(
          `[GithubReviewWatcher] Review detected: PR #${item.event.prNumber} cat=${item.event.catTag ?? 'none'} (${item.event.reviewType})`,
        );

        if (this.reviewHandler) {
          try {
            await this.reviewHandler(item.event);
            this.lastSeenUid = Math.max(this.lastSeenUid, item.uid);
          } catch (err) {
            this.log.error(
              `[GithubReviewWatcher] Handler failed for UID ${item.uid}, will retry next poll: ${String(err)}`,
            );
            break; // Stop — don't advance past failed UID
          }
        } else {
          this.emit('review', item.event);
          this.lastSeenUid = Math.max(this.lastSeenUid, item.uid);
        }
      }
    } finally {
      lock.release();
    }
  }
}

/**
 * Extract rich error detail from ImapFlow errors.
 * ImapFlow attaches `responseStatus` and `executedCommand` but `String(error)`
 * only shows the generic "Command failed". This preserves diagnostics in logs.
 */
function formatImapError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & { responseStatus?: string; executedCommand?: string };
  const parts = [error.message];
  if (e.responseStatus) parts.push(`status=${e.responseStatus}`);
  if (e.executedCommand) parts.push(`cmd=${e.executedCommand}`);
  return parts.join(' | ');
}

/** Network/connection errors that should trigger a reconnect (not a crash). */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  const connectionCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
  ]);
  if (code && connectionCodes.has(code)) return true;
  // ImapFlow sometimes wraps errors without preserving code
  const msg = error.message.toLowerCase();
  return msg.includes('timeout') || msg.includes('connection') || msg.includes('socket');
}

/**
 * Load watcher config from environment variables.
 * Returns null if required env vars are not set.
 */
export function loadWatcherConfigFromEnv(): GithubReviewWatcherConfig | null {
  const user = process.env.GITHUB_REVIEW_IMAP_USER;
  const pass = process.env.GITHUB_REVIEW_IMAP_PASS;

  if (!user || !pass) {
    return null;
  }

  const pollIntervalMs = parseInt(process.env.GITHUB_REVIEW_POLL_INTERVAL_MS ?? '120000', 10);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 5000) {
    throw new Error(
      `[GithubReviewWatcher] Invalid GITHUB_REVIEW_POLL_INTERVAL_MS: ${process.env.GITHUB_REVIEW_POLL_INTERVAL_MS} (must be >= 5000ms)`,
    );
  }

  return {
    user,
    pass,
    host: process.env.GITHUB_REVIEW_IMAP_HOST ?? 'imap.qq.com',
    port: parseInt(process.env.GITHUB_REVIEW_IMAP_PORT ?? '993', 10),
    pollIntervalMs,
    proxy: process.env.GITHUB_REVIEW_IMAP_PROXY || undefined,
  };
}
