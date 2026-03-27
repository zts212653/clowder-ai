/**
 * XiaoYi (华为小艺) Smart Assistant Adapter
 * Connects to Huawei XiaoYi A2A platform via dual WebSocket channels.
 *
 * Inbound: Parse A2A message/stream events → extract user text + attachments
 * Outbound: Send artifact-update (text) via A2A JSON-RPC 2.0
 *
 * F139 XiaoYi Smart Assistant Gateway — Phase A
 */

import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
// @ts-expect-error — ws has no bundled types; @types/ws not in this project
import { WebSocket } from 'ws';
import type { IOutboundAdapter } from '../OutboundDeliveryHook.js';

// ── Types ──

export interface XiaoyiAdapterOptions {
  /** HMAC Access Key from 小艺开放平台 */
  ak: string;
  /** HMAC Secret Key from 小艺开放平台 */
  sk: string;
  /** Agent ID registered on 小艺开放平台 */
  agentId: string;
  /** Primary WebSocket URL */
  wsUrl1?: string;
  /** Backup WebSocket URL (IP-based) */
  wsUrl2?: string;
  /** Enable streaming mode (default true) */
  enableStreaming?: boolean;
}

export interface XiaoyiInboundMessage {
  /** A2A session ID — used as externalChatId */
  chatId: string;
  /** User text content */
  text: string;
  /** A2A task ID — used as messageId */
  messageId: string;
  /** A2A task ID (same as messageId, kept for session tracking) */
  taskId: string;
  /** File attachments from user */
  attachments?: XiaoyiAttachment[];
}

export interface XiaoyiAttachment {
  type: 'image' | 'file' | 'audio';
  url: string;
  fileName?: string;
  mimeType?: string;
}

// ── Constants ──

const DEFAULT_WS_URL = 'wss://hag.cloud.huawei.com/openclaw/v1/ws/link';
const HEARTBEAT_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MESSAGE_DEDUP_WINDOW_MS = 300_000; // 5 min

// ── HMAC-SHA256 Signature ──

export function generateXiaoyiSignature(sk: string, timestamp: string): string {
  return createHmac('sha256', sk).update(timestamp).digest('base64');
}

// ── A2A Protocol Helpers ──

function buildAgentResponse(
  agentId: string,
  sessionId: string,
  taskId: string,
  msgDetail: Record<string, unknown>,
): Record<string, unknown> {
  return {
    msgType: 'agent_response',
    agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(msgDetail),
  };
}

function buildTextArtifactUpdate(
  taskId: string,
  text: string,
  opts: { append?: boolean; lastChunk?: boolean; final?: boolean; kind?: 'text' | 'reasoningText' } = {},
): Record<string, unknown> {
  const kind = opts.kind ?? 'text';
  const partKey = kind === 'reasoningText' ? 'reasoningText' : 'text';
  return {
    jsonrpc: '2.0',
    id: `msg_${Date.now()}`,
    result: {
      taskId,
      kind: 'artifact-update',
      append: opts.append ?? false,
      lastChunk: opts.lastChunk ?? true,
      final: opts.final ?? true,
      artifact: {
        artifactId: `artifact_${Date.now()}`,
        parts: [{ kind, [partKey]: text }],
      },
    },
  };
}

function buildStatusUpdate(
  taskId: string,
  state: 'working' | 'completed' | 'failed',
  message?: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: `msg_${Date.now()}`,
    result: {
      taskId,
      kind: 'status-update',
      final: state !== 'working',
      status: {
        state,
        ...(message ? { message: { role: 'agent', parts: [{ kind: 'text', text: message }] } } : {}),
      },
    },
  };
}

// ── Inbound Message Parser ──

interface A2AMessageParts {
  text: string;
  files: XiaoyiAttachment[];
  pushId?: string;
}

function parseA2AMessageParts(parts: unknown[]): A2AMessageParts {
  let text = '';
  const files: XiaoyiAttachment[] = [];
  let pushId: string | undefined;

  for (const part of parts) {
    const p = part as Record<string, unknown>;
    if (p.kind === 'text' && typeof p.text === 'string') {
      text += p.text;
    } else if (p.kind === 'file') {
      const file = p.file as Record<string, unknown> | undefined;
      if (file?.uri) {
        files.push({
          type: guessFileType(file.mimeType as string | undefined),
          url: file.uri as string,
          fileName: file.name as string | undefined,
          mimeType: file.mimeType as string | undefined,
        });
      }
    } else if (p.kind === 'data') {
      const data = p.data as Record<string, unknown> | undefined;
      const vars = data?.variables as Record<string, unknown> | undefined;
      const sysVars = vars?.systemVariables as Record<string, unknown> | undefined;
      if (sysVars?.push_id) {
        pushId = sysVars.push_id as string;
      }
    }
  }

  return { text, files, pushId };
}

function guessFileType(mimeType: string | undefined): 'image' | 'file' | 'audio' {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

// ── Single WebSocket Channel ──

interface WsChannel {
  ws: WebSocket | null;
  url: string;
  label: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  initSent: boolean;
}

// ── XiaoyiAdapter ──

export class XiaoyiAdapter implements IOutboundAdapter {
  readonly connectorId = 'xiaoyi';

  private readonly opts: Required<Pick<XiaoyiAdapterOptions, 'ak' | 'sk' | 'agentId'>> & XiaoyiAdapterOptions;
  private readonly log: FastifyBaseLogger;
  private readonly channels: [WsChannel, WsChannel];
  private running = false;
  private onMessage: ((msg: XiaoyiInboundMessage) => Promise<void>) | null = null;

  /** Dedup inbound messages (taskId → timestamp) */
  private readonly seenMessages = new Map<string, number>();

  /** Track active sessions: taskId → sessionId */
  private readonly sessionMap = new Map<string, string>();

  constructor(log: FastifyBaseLogger, options: XiaoyiAdapterOptions) {
    this.log = log;
    this.opts = {
      wsUrl1: DEFAULT_WS_URL,
      enableStreaming: true,
      ...options,
    };
    this.channels = [
      this.createChannel(this.opts.wsUrl1!, 'primary'),
      this.createChannel(this.opts.wsUrl2 ?? this.opts.wsUrl1!, 'backup'),
    ];
  }

  // ── Lifecycle ──

  startConnection(onMessage: (msg: XiaoyiInboundMessage) => Promise<void>): void {
    this.onMessage = onMessage;
    this.running = true;
    for (const ch of this.channels) {
      this.connect(ch);
    }
    this.log.info('[XiaoYi] Adapter started (dual WebSocket A2A)');
  }

  async stopConnection(): Promise<void> {
    this.running = false;
    for (const ch of this.channels) {
      this.closeChannel(ch);
    }
    this.sessionMap.clear();
    this.seenMessages.clear();
    this.log.info('[XiaoYi] Adapter stopped');
  }

  // ── IOutboundAdapter ──

  async sendReply(externalChatId: string, content: string): Promise<void> {
    const sessionId = externalChatId;
    const taskId = this.resolveTaskId(sessionId);
    if (!taskId) {
      this.log.warn({ sessionId }, '[XiaoYi] No active task for session, dropping reply');
      return;
    }

    const msgDetail = buildTextArtifactUpdate(taskId, content, {
      append: false,
      lastChunk: true,
      final: true,
    });
    const payload = buildAgentResponse(this.opts.agentId, sessionId, taskId, msgDetail);
    await this.sendToAll(payload);
  }

  // ── Internal: Connection Management ──

  private createChannel(url: string, label: string): WsChannel {
    return { ws: null, url, label, heartbeatTimer: null, reconnectAttempt: 0, reconnectTimer: null, initSent: false };
  }

  private connect(ch: WsChannel): void {
    if (!this.running) return;

    const timestamp = Date.now().toString();
    const signature = generateXiaoyiSignature(this.opts.sk, timestamp);

    const headers: Record<string, string> = {
      'x-access-key': this.opts.ak,
      'x-sign': signature,
      'x-ts': timestamp,
      'x-agent-id': this.opts.agentId,
    };

    // IP-based URLs need special SSL handling
    const isIpUrl = /wss?:\/\/\d+\.\d+\.\d+\.\d+/.test(ch.url);
    const wsOptions: Record<string, unknown> = { headers };
    if (isIpUrl) {
      wsOptions.rejectUnauthorized = false;
    }

    try {
      ch.ws = new WebSocket(ch.url, wsOptions);
    } catch (err) {
      this.log.error({ err, channel: ch.label }, '[XiaoYi] WebSocket creation failed');
      this.scheduleReconnect(ch);
      return;
    }

    ch.ws.on('open', () => {
      this.log.info({ channel: ch.label }, '[XiaoYi] WebSocket connected');
      ch.reconnectAttempt = 0;
      this.sendInit(ch);
      this.startHeartbeat(ch);
    });

    ch.ws.on('message', (data: Buffer | string) => {
      this.handleRawMessage(ch, data.toString());
    });

    ch.ws.on('close', (code: number, reason: Buffer) => {
      this.log.warn({ channel: ch.label, code, reason: reason.toString() }, '[XiaoYi] WebSocket closed');
      this.stopHeartbeat(ch);
      this.scheduleReconnect(ch);
    });

    ch.ws.on('error', (err: Error) => {
      this.log.error({ err, channel: ch.label }, '[XiaoYi] WebSocket error');
    });
  }

  private sendInit(ch: WsChannel): void {
    if (ch.initSent) return;
    const initMsg = { msgType: 'clawd_bot_init', agentId: this.opts.agentId };
    this.sendToChannel(ch, initMsg);
    ch.initSent = true;
    this.log.info({ channel: ch.label }, '[XiaoYi] Init message sent');
  }

  private startHeartbeat(ch: WsChannel): void {
    this.stopHeartbeat(ch);
    ch.heartbeatTimer = setInterval(() => {
      if (ch.ws?.readyState === WebSocket.OPEN) {
        this.sendToChannel(ch, { msgType: 'heartbeat', agentId: this.opts.agentId });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(ch: WsChannel): void {
    if (ch.heartbeatTimer) {
      clearInterval(ch.heartbeatTimer);
      ch.heartbeatTimer = null;
    }
  }

  private closeChannel(ch: WsChannel): void {
    this.stopHeartbeat(ch);
    if (ch.reconnectTimer) {
      clearTimeout(ch.reconnectTimer);
      ch.reconnectTimer = null;
    }
    if (ch.ws) {
      ch.ws.removeAllListeners();
      ch.ws.close();
      ch.ws = null;
    }
    ch.initSent = false;
  }

  private scheduleReconnect(ch: WsChannel): void {
    if (!this.running) return;
    this.closeChannel(ch);

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** ch.reconnectAttempt, RECONNECT_MAX_MS);
    ch.reconnectAttempt++;
    this.log.info({ channel: ch.label, delay, attempt: ch.reconnectAttempt }, '[XiaoYi] Scheduling reconnect');

    ch.reconnectTimer = setTimeout(() => {
      ch.reconnectTimer = null;
      this.connect(ch);
    }, delay);
  }

  // ── Internal: Message Handling ──

  private handleRawMessage(ch: WsChannel, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log.warn({ channel: ch.label, raw: raw.slice(0, 200) }, '[XiaoYi] Non-JSON message');
      return;
    }

    const msgType = msg.msgType as string | undefined;
    const method = msg.method as string | undefined;

    // Heartbeat — ignore
    if (msgType === 'heartbeat') return;

    // clearContext — acknowledge
    if (method === 'clearContext') {
      this.handleClearContext(msg);
      return;
    }

    // tasks/cancel
    if (method === 'tasks/cancel') {
      this.handleTaskCancel(msg);
      return;
    }

    // message/stream — the main inbound path
    if (msgType === 'message/stream' || method === 'message/stream') {
      this.handleMessageStream(ch, msg);
      return;
    }

    this.log.debug({ channel: ch.label, msgType, method }, '[XiaoYi] Unhandled message type');
  }

  private handleMessageStream(ch: WsChannel, msg: Record<string, unknown>): void {
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) return;

    const sessionId = (msg.sessionId ?? params.sessionId) as string | undefined;
    const taskId = (params.id ?? msg.taskId) as string | undefined;
    if (!sessionId || !taskId) {
      this.log.warn('[XiaoYi] message/stream missing sessionId or taskId');
      return;
    }

    // Dedup across dual channels
    if (this.isDuplicate(taskId)) return;

    // Track session → task mapping
    this.sessionMap.set(taskId, sessionId);

    const message = params.message as Record<string, unknown> | undefined;
    const parts = (message?.parts ?? []) as unknown[];
    const parsed = parseA2AMessageParts(parts);

    if (!parsed.text && parsed.files.length === 0) {
      this.log.debug({ sessionId, taskId }, '[XiaoYi] Empty message, skipping');
      return;
    }

    const inbound: XiaoyiInboundMessage = {
      chatId: sessionId,
      text: parsed.text,
      messageId: taskId,
      taskId,
      attachments: parsed.files.length > 0 ? parsed.files : undefined,
    };

    this.onMessage?.(inbound).catch((err) => {
      this.log.error({ err, sessionId, taskId }, '[XiaoYi] onMessage handler error');
    });
  }

  private handleClearContext(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    this.log.info({ sessionId }, '[XiaoYi] clearContext received');
  }

  private handleTaskCancel(msg: Record<string, unknown>): void {
    const params = msg.params as Record<string, unknown> | undefined;
    const taskId = (params?.id ?? msg.taskId) as string | undefined;
    if (taskId) {
      this.sessionMap.delete(taskId);
    }
    this.log.info({ taskId }, '[XiaoYi] tasks/cancel received');
  }

  // ── Internal: Dedup ──

  private isDuplicate(taskId: string): boolean {
    const now = Date.now();
    // Sweep old entries
    if (this.seenMessages.size > 1000) {
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > MESSAGE_DEDUP_WINDOW_MS) this.seenMessages.delete(id);
      }
    }

    if (this.seenMessages.has(taskId)) return true;
    this.seenMessages.set(taskId, now);
    return false;
  }

  // ── Internal: Send ──

  private sendToChannel(ch: WsChannel, payload: unknown): void {
    if (ch.ws?.readyState === WebSocket.OPEN) {
      ch.ws.send(JSON.stringify(payload));
    }
  }

  private async sendToAll(payload: unknown): Promise<void> {
    for (const ch of this.channels) {
      this.sendToChannel(ch, payload);
    }
  }

  private resolveTaskId(sessionId: string): string | undefined {
    // Find taskId by sessionId (reverse lookup)
    for (const [taskId, sid] of this.sessionMap) {
      if (sid === sessionId) return taskId;
    }
    return undefined;
  }
}
