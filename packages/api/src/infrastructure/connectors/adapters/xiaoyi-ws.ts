/**
 * XiaoYi WebSocket connection manager — dual-channel HA with reconnect
 *
 * Handles: connect, auth (HMAC-SHA256), heartbeat, ping/pong, reconnect,
 * channel failover, and send routing (session affinity with fallback).
 *
 * F151 | ADR-014
 */

import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import {
  APP_HEARTBEAT_MS,
  envelope,
  generateXiaoyiSignature,
  MAX_RECONNECT,
  PONG_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  WS_BACKUP,
  WS_PING_MS,
  WS_PRIMARY,
  type WsChannel,
  type XiaoyiAdapterOptions,
} from './xiaoyi-protocol.js';

export class XiaoyiWsManager {
  private channels: WsChannel[] = [];
  private running = false;
  private onMessage: ((raw: string, source: string) => void) | null = null;

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly opts: XiaoyiAdapterOptions,
  ) {}

  start(onMessage: (raw: string, source: string) => void): void {
    this.onMessage = onMessage;
    this.running = true;
    this.channels = [
      this.mkChannel(this.opts.wsUrl1 ?? WS_PRIMARY, 'primary'),
      this.mkChannel(this.opts.wsUrl2 ?? WS_BACKUP, 'backup'),
    ];
    for (const ch of this.channels) this.connect(ch);
  }

  stop(): void {
    this.running = false;
    this.onMessage = null;
    for (const ch of this.channels) this.disconnect(ch);
    this.channels = [];
  }

  send(preferred: string, payload: string): void {
    const ch = this.channels.find((c) => c.label === preferred);
    if (ch?.ws && ch.ws.readyState === WebSocket.OPEN) {
      ch.ws.send(payload);
      return;
    }
    const fb = this.channels.find((c) => c.label !== preferred && c.ws?.readyState === WebSocket.OPEN);
    if (fb?.ws) {
      this.log.warn({ from: preferred, to: fb.label }, '[XiaoYi] Channel fallback');
      fb.ws.send(payload);
      return;
    }
    this.log.error('[XiaoYi] No channel available');
  }

  private mkChannel(url: string, label: string): WsChannel {
    return { ws: null, url, label, appTimer: null, pingTimer: null, lastPong: 0, reconnects: 0, reconnectTimer: null };
  }

  private connect(ch: WsChannel): void {
    if (!this.running) return;
    const ts = Date.now().toString();
    const sig = generateXiaoyiSignature(this.opts.sk, ts);
    const headers = { 'x-access-key': this.opts.ak, 'x-sign': sig, 'x-ts': ts, 'x-agent-id': this.opts.agentId };
    const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(new URL(ch.url).hostname);
    this.log.info({ label: ch.label, url: ch.url }, '[XiaoYi] Connecting');
    const ws = new WebSocket(ch.url, { headers, rejectUnauthorized: !isIp });
    ws.on('open', () => {
      ch.reconnects = 0;
      ch.lastPong = Date.now();
      ws.send(envelope(this.opts.agentId, 'clawd_bot_init'));
      ch.appTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(envelope(this.opts.agentId, 'heartbeat'));
      }, APP_HEARTBEAT_MS);
      ch.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - ch.lastPong > PONG_TIMEOUT_MS) {
          this.log.warn({ label: ch.label }, '[XiaoYi] Pong timeout');
          ws.terminate();
          return;
        }
        ws.ping();
      }, WS_PING_MS);
      this.log.info({ label: ch.label }, '[XiaoYi] Connected');
    });
    ws.on('pong', () => {
      ch.lastPong = Date.now();
    });
    ws.on('message', (raw: Buffer) => this.onMessage?.(raw.toString(), ch.label));
    ws.on('close', () => {
      ch.ws = null;
      this.clearWsTimers(ch);
      if (this.running) this.scheduleReconnect(ch);
    });
    ws.on('error', (err: unknown) => this.log.warn({ err, label: ch.label }, '[XiaoYi] WS error'));
    ch.ws = ws;
  }

  private disconnect(ch: WsChannel): void {
    this.clearWsTimers(ch);
    if (ch.ws) {
      ch.ws.removeAllListeners();
      ch.ws.terminate();
      ch.ws = null;
    }
  }

  private clearWsTimers(ch: WsChannel): void {
    if (ch.appTimer) {
      clearInterval(ch.appTimer);
      ch.appTimer = null;
    }
    if (ch.pingTimer) {
      clearInterval(ch.pingTimer);
      ch.pingTimer = null;
    }
    if (ch.reconnectTimer) {
      clearTimeout(ch.reconnectTimer);
      ch.reconnectTimer = null;
    }
  }

  private scheduleReconnect(ch: WsChannel): void {
    if (ch.reconnects >= MAX_RECONNECT) {
      this.log.error({ label: ch.label }, '[XiaoYi] Max reconnects');
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** ch.reconnects, RECONNECT_MAX_MS);
    ch.reconnects++;
    ch.reconnectTimer = setTimeout(() => this.connect(ch), delay);
  }
}
