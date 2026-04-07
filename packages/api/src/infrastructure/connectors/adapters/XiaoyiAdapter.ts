/**
 * XiaoYi (小艺) Connector Adapter — OpenClaw A2A over dual-WS.
 *
 * Non-streaming delivery: each cat's complete reply sent via sendReply with
 * append accumulation (first=false, rest=true). No intra-artifact streaming
 * — HAG app breaks with append:true delta updates within the same artifact.
 * Task closure via close frame driven by onDeliveryBatchDone signal.
 *
 * F151 | ADR-014
 */

import type { FastifyBaseLogger } from 'fastify';
import type { IStreamableOutboundAdapter } from '../OutboundDeliveryHook.js';
import {
  type A2AInbound,
  agentResponse,
  artifactUpdate,
  DEDUP_TTL_MS,
  generateXiaoyiSignature,
  STATUS_KEEPALIVE_MS,
  statusUpdate,
  TASK_TIMEOUT_MS,
  type TaskRecord,
  type XiaoyiAdapterOptions,
  type XiaoyiInboundMessage,
} from './xiaoyi-protocol.js';
import { XiaoyiWsManager } from './xiaoyi-ws.js';

export type { XiaoyiAdapterOptions, XiaoyiInboundMessage };
export { generateXiaoyiSignature };

export class XiaoyiAdapter implements IStreamableOutboundAdapter {
  readonly connectorId = 'xiaoyi' as const;
  private readonly log: FastifyBaseLogger;
  private readonly opts: XiaoyiAdapterOptions;
  private readonly ws: XiaoyiWsManager;
  /** Per-session FIFO queue of HAG tasks */
  private readonly taskQueue = new Map<string, TaskRecord[]>();
  private readonly dedup = new Map<string, number>();
  /** Per-task artifact sequence counter — keyed by session:task */
  private readonly seqCounters = new Map<string, number>();
  /** Keepalive timers — keyed by session:task */
  private readonly keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Task timeout timers — keyed by session:task */
  private readonly taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Deferred inbound payloads for queued tasks — keyed by session:task */
  private readonly pendingDispatch = new Map<string, XiaoyiInboundMessage>();
  /** Track whether a task has sent at least one artifact — keyed by session:task */
  private readonly hasArtifact = new Set<string>();

  constructor(log: FastifyBaseLogger, opts: XiaoyiAdapterOptions) {
    this.log = log;
    this.opts = opts;
    this.ws = new XiaoyiWsManager(log, opts);
  }

  // ── Lifecycle ──

  async startStream(onMessage: (msg: XiaoyiInboundMessage) => Promise<void>): Promise<void> {
    this.onMsg = onMessage;
    this.ws.start((raw, source) => this.handleInbound(raw, source));
  }

  async stopStream(): Promise<void> {
    this.onMsg = null;
    this.ws.stop();
    for (const t of this.taskTimeouts.values()) clearTimeout(t);
    this.taskTimeouts.clear();
    for (const t of this.keepaliveTimers.values()) clearInterval(t);
    this.keepaliveTimers.clear();
    this.taskQueue.clear();
    this.seqCounters.clear();
    this.dedup.clear();
    this.pendingDispatch.clear();
    this.hasArtifact.clear();
  }

  private onMsg: ((msg: XiaoyiInboundMessage) => Promise<void>) | null = null;

  // ── Helpers ──

  /** Compound key for per-task maps, namespaced by session to prevent cross-session collision */
  private taskKey(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`;
  }

  // ── IStreamableOutboundAdapter ──

  async sendReply(externalChatId: string, content: string): Promise<void> {
    const sessionId = this.sessionFrom(externalChatId);
    const rec = this.currentTask(sessionId);
    if (!rec) {
      this.log.warn({ sessionId }, '[XiaoYi] No task for sendReply');
      return;
    }
    const tk = this.taskKey(sessionId, rec.taskId);
    const isFirst = !this.hasArtifact.has(tk);
    const artId = this.nextArtifactId(sessionId, rec.taskId);
    const text = isFirst ? content : `\n\n---\n\n${content}`;
    const art = artifactUpdate(rec.taskId, artId, text, { append: !isFirst, lastChunk: true });
    this.ws.send(rec.source, agentResponse(this.opts.agentId, sessionId, rec.taskId, art));
    this.hasArtifact.add(tk);
  }

  async onDeliveryBatchDone(externalChatId: string, chainDone: boolean): Promise<void> {
    if (!chainDone) return;
    const sessionId = this.sessionFrom(externalChatId);
    const rec = this.currentTask(sessionId);
    if (!rec) return;
    const tk = this.taskKey(sessionId, rec.taskId);
    this.cancelTaskTimeout(sessionId, rec.taskId);
    this.clearKeepalive(sessionId, rec.taskId);
    this.pendingDispatch.delete(tk);
    // Close frame: completed if has artifact, failed if no output at all
    const state = this.hasArtifact.has(tk) ? 'completed' : 'failed';
    const close = statusUpdate(rec.taskId, state);
    this.ws.send(rec.source, agentResponse(this.opts.agentId, sessionId, rec.taskId, close));
    this.dequeueTask(sessionId, rec.taskId);
  }

  async sendPlaceholder(externalChatId: string, _text: string): Promise<string> {
    const sessionId = this.sessionFrom(externalChatId);
    const rec = this.currentTask(sessionId);
    if (!rec) {
      this.log.warn({ sessionId }, '[XiaoYi] No task for sendPlaceholder');
      return '';
    }
    // Content delivered via sendReply only (no intra-artifact streaming).
    const st = statusUpdate(rec.taskId, 'working');
    this.ws.send(rec.source, agentResponse(this.opts.agentId, sessionId, rec.taskId, st));
    // Thinking bubble — reasoningText renders separately and collapses on reply
    const thinkId = this.nextArtifactId(sessionId, rec.taskId);
    const thinking = artifactUpdate(rec.taskId, thinkId, '', {
      append: false,
      lastChunk: true,
      partKind: 'reasoningText',
    });
    this.ws.send(rec.source, agentResponse(this.opts.agentId, sessionId, rec.taskId, thinking));
    this.startKeepalive(rec.taskId, sessionId, rec);
    return '';
  }

  async editMessage(): Promise<void> {
    // No-op: XiaoYi delivers final text only via sendReply
  }

  async deleteMessage(): Promise<void> {
    // No-op: no streaming artifacts to finalize
  }

  // ── Inbound ──

  private handleInbound(raw: string, source: string): void {
    let msg: A2AInbound;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const inboundAgentId = msg.agentId ?? msg.params?.agentId;
    if (inboundAgentId && inboundAgentId !== this.opts.agentId) return;
    if (msg.method === 'message/stream' && msg.params) {
      this.handleMessageStream(msg, source);
    } else if (msg.method === 'tasks/cancel' || msg.method === 'clearContext') {
      const sid = msg.params?.sessionId ?? msg.sessionId;
      if (sid) this.purgeSession(sid);
    } else if ((msg as Record<string, unknown>).error) {
      this.log.warn({ error: (msg as Record<string, unknown>).error, source }, '[XiaoYi] HAG JSON-RPC error');
    }
  }

  private handleMessageStream(msg: A2AInbound, source: string): void {
    const taskId = msg.params?.id;
    const sessionId = msg.params?.sessionId;
    if (!taskId || !sessionId) return;
    const key = `${sessionId}:${taskId}`;
    if (this.dedup.has(key)) return;
    this.dedup.set(key, Date.now());
    this.gcDedup();

    const rec: TaskRecord = { taskId, source };
    const queue = this.taskQueue.get(sessionId) ?? [];
    queue.push(rec);
    this.taskQueue.set(sessionId, queue);
    this.startTaskTimeout(taskId, sessionId, rec);

    const text = (msg.params?.message?.parts ?? [])
      .filter((p): p is { kind: string; text: string } => p.kind === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (!text) return;
    const chatId = `${this.opts.agentId}:${sessionId}`;
    const senderId = `owner:${this.opts.agentId}`;
    const payload: XiaoyiInboundMessage = { chatId, text, messageId: taskId, taskId, senderId };

    if (queue.length > 1) {
      const st = statusUpdate(taskId, 'working');
      this.ws.send(source, agentResponse(this.opts.agentId, sessionId, taskId, st));
      this.startKeepalive(taskId, sessionId, rec);
      this.pendingDispatch.set(this.taskKey(sessionId, taskId), payload);
      return;
    }
    this.onMsg?.(payload).catch((err: unknown) => this.log.error({ err, taskId }, '[XiaoYi] Callback failed'));
  }

  // ── Task Timeout (safety net) ──

  private startTaskTimeout(taskId: string, sessionId: string, rec: TaskRecord): void {
    const tk = this.taskKey(sessionId, taskId);
    this.cancelTaskTimeout(sessionId, taskId);
    this.taskTimeouts.set(
      tk,
      setTimeout(() => {
        this.taskTimeouts.delete(tk);
        this.clearKeepalive(sessionId, taskId);
        this.pendingDispatch.delete(tk);
        // Close frame with failed state if no artifact, completed if has artifact
        const state = this.hasArtifact.has(tk) ? 'completed' : 'failed';
        const close = statusUpdate(rec.taskId, state);
        this.ws.send(rec.source, agentResponse(this.opts.agentId, sessionId, rec.taskId, close));
        this.dequeueTask(sessionId, taskId);
        this.log.warn({ sessionId, taskId }, '[XiaoYi] Task timeout — force closed');
      }, TASK_TIMEOUT_MS),
    );
  }

  private cancelTaskTimeout(sessionId: string, taskId: string): void {
    const tk = this.taskKey(sessionId, taskId);
    const t = this.taskTimeouts.get(tk);
    if (t) {
      clearTimeout(t);
      this.taskTimeouts.delete(tk);
    }
  }

  // ── Keepalive ──

  private startKeepalive(taskId: string, sessionId: string, rec: TaskRecord): void {
    const tk = this.taskKey(sessionId, taskId);
    if (this.keepaliveTimers.has(tk)) return;
    this.keepaliveTimers.set(
      tk,
      setInterval(() => {
        const ka = statusUpdate(rec.taskId, 'working');
        this.ws.send(rec.source, agentResponse(this.opts.agentId, sessionId, rec.taskId, ka));
      }, STATUS_KEEPALIVE_MS),
    );
  }

  private clearKeepalive(sessionId: string, taskId: string): void {
    const tk = this.taskKey(sessionId, taskId);
    const t = this.keepaliveTimers.get(tk);
    if (t) {
      clearInterval(t);
      this.keepaliveTimers.delete(tk);
    }
  }

  // ── Queue Management ──

  private currentTask(sessionId: string): TaskRecord | undefined {
    return this.taskQueue.get(sessionId)?.[0];
  }

  private nextArtifactId(sessionId: string, taskId: string): string {
    const tk = this.taskKey(sessionId, taskId);
    const seq = (this.seqCounters.get(tk) ?? 0) + 1;
    this.seqCounters.set(tk, seq);
    return `${taskId}:${seq}`;
  }

  private dequeueTask(sessionId: string, taskId: string): void {
    const q = this.taskQueue.get(sessionId);
    if (!q) return;
    const idx = q.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) q.splice(idx, 1);
    if (q.length === 0) this.taskQueue.delete(sessionId);
    const tk = this.taskKey(sessionId, taskId);
    this.seqCounters.delete(tk);
    this.hasArtifact.delete(tk);
    // Dispatch next queued task
    const next = q?.[0];
    const nextTk = next && this.taskKey(sessionId, next.taskId);
    const pending = nextTk && this.pendingDispatch.get(nextTk);
    if (pending) {
      this.pendingDispatch.delete(nextTk);
      this.onMsg?.(pending).catch((e: unknown) => this.log.error({ err: e }, '[XiaoYi] Dispatch failed'));
    }
  }

  private purgeSession(sid: string): void {
    for (const t of this.taskQueue.get(sid) ?? []) {
      const tk = this.taskKey(sid, t.taskId);
      this.cancelTaskTimeout(sid, t.taskId);
      this.clearKeepalive(sid, t.taskId);
      this.seqCounters.delete(tk);
      this.hasArtifact.delete(tk);
      this.pendingDispatch.delete(tk);
    }
    this.taskQueue.delete(sid);
  }

  private sessionFrom(externalChatId: string): string {
    const idx = externalChatId.indexOf(':');
    return idx >= 0 ? externalChatId.slice(idx + 1) : externalChatId;
  }

  private gcDedup(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, ts] of this.dedup) {
      if (ts < cutoff) this.dedup.delete(k);
    }
  }
}
